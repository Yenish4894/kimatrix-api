# sena-temp — Frontend API Integration Guide

> **Audience:** sena-temp frontend team.
> **Backend base URL (dev):** `http://localhost:5000`
> **Backend base URL (prod):** TBD — coordinate with backend ops.
> **Backend version:** Phase 1-6 + PayPal payments (last updated 2026-05-24).

Exact request/response shapes, headers, and error codes for every endpoint. Pair with `FRONTEND_FLOWS.md` for user-journey context.

## Changelog since 2026-04-17

- **(2026-05-24) PayPal payment gateway integrated.** Companies self-service subscribe to a plan; account auto-activates on capture. Manual super-admin activation is now an override-only path. New endpoints: `GET /api/payments/plans`, `POST /api/payments/paypal/create-order`, `POST /api/payments/paypal/capture-order`. New pages required: `/company/billing`, `/company/billing/success`, `/company/billing/cancel`. `GET /api/company/profile` now includes `subscriptionExpiresAt` and `currentPlan` fields. Data routes (`/stats`, `/customers`, `/purchases`) now require an active subscription — 403 if expired or null. Profile + billing routes bypass this gate.
- **(2026-05-24) Registration flow updated.** The pending-activation screen should now direct users to `/company/billing` to subscribe, instead of instructing them to wait for manual admin verification.

- **(2026-05-03) QR submit: 15-minute resubmit cooldown per `(company, mobile)`.** A mobile that successfully submitted a receipt at a company can't submit another at the SAME company for 15 minutes. Returns `429 RATE_LIMIT_EXCEEDED` with remaining minutes in the message. Vehicle-agnostic (applies to fuel-station mobiles regardless of vehicle).
- **(2026-05-03) Password reset emails are now actually delivered.** Production flow: `POST /api/auth/password-reset/request` enqueues a BullMQ job, the email worker renders the branded HTML template, and SMTP (nodemailer) sends to the user. Reset URL format unchanged: `${FRONTEND_BASE_URL}/reset-password?token=...`.
- **(2026-05-03) Conflict (`409 RESOURCE_CONFLICT`) responses now use friendly per-field messages instead of leaking Postgres detail strings.** FE can rely on `details[].field` to highlight the right input.
- **(2026-05-03) All rate limiters are Redis-backed.** No effective behavior change for FE — the rate-limit headers (`RateLimit-*`) and 429 responses look the same.
- **BREAKING (2026-05-03) — Address split into 5 structured fields**: `address` (single string) is **gone**. Replaced with `streetAddress`, `city`, `state`, `country` (required) + `postalCode` (optional/nullable). Affects request/response of `register/company`, `GET /company/profile`, `PUT /company/profile`, `GET /admin/companies`, `GET /admin/companies/:id`. Sending the legacy `address` key now returns a `VALIDATION_ERROR`.
- **BREAKING — `POST /api/auth/register/company`**: company is now created in **pending** state (`isActive=false`), **NO tokens are issued**, response message updated. Login is blocked until super admin activates the company.
- **NEW — `PUT /api/company/profile`**: company can edit address fields, contact email/phone, WhatsApp, and promo opt-in (each address sub-field is independently editable, partial update).
- **NEW — `POST /api/auth/password-change`**: any authenticated user (company or super admin) can change their password in-app.
- **NEW — `GET /api/company/customers/export`**: CSV export of all customers.
- **NEW — `GET /api/company/purchases/export`**: CSV export of all purchases.
- **Three-state company status**: companies are now either Pending / Active / Deactivated (derivable from `isActive` + `deactivatedAt`).

---

## 1. Envelope formats

### Success

```json
{
  "success": true,
  "message": "Operation successful",
  "data": {
    /* endpoint-specific payload */
  },
  "timestamp": "2026-04-17T10:00:00.000Z"
}
```

Some endpoints return `"data": null` with a human-readable `message` (e.g., logout, reset requests, activate/deactivate).

### Paginated list

```json
{
  "success": true,
  "data": {
    "items": [
      /* entities */
    ],
    "pagination": {
      "total": 150,
      "page": 1,
      "limit": 10,
      "totalPages": 15
    }
  }
}
```

### Pagination contract (which endpoints paginate, which don't)

**In-app list endpoints — ALWAYS paginated:**
| Endpoint | Default | Max limit |
|---|---|---|
| `GET /api/admin/companies` | `page=1, limit=10` | 100 |
| `GET /api/company/customers` | `page=1, limit=10` | 100 |
| `GET /api/company/purchases` | `page=1, limit=10` | 100 |

All paginated lists accept `page` + `limit` as query params and return the `{ items, pagination }` shape above.

**Bulk-export endpoints — INTENTIONALLY NOT paginated** (they return everything in one response by design):

- `GET /api/company/customers/export` — CSV of all customers
- `GET /api/company/purchases/export` — CSV of all purchases
- (Future) `GET /api/company/reports/top-10` — fixed-cap PDF
- (Future) `GET /api/company/reports/all-customers` — full PDF

**Single-record endpoints** (`/profile`, `/stats`, `/:id`) — n/a, return one object.

**FE rule of thumb:** if you're rendering a table the user scrolls / sorts / filters, the endpoint paginates. If you're triggering a download, it doesn't.

### Error

```json
{
  "success": false,
  "message": "human-readable message",
  "error": "ERROR_CODE",
  "details": [{ "field": "email", "message": "must be a valid email" }],
  "requestId": "a1b2c3d4-...",
  "timestamp": "2026-04-17T10:00:00.000Z"
}
```

`details` is only present on `VALIDATION_ERROR` or `RESOURCE_CONFLICT`.
`requestId` appears on every error response — include it in support tickets.

### Error codes

| Code                  | HTTP | Meaning                                                                   |
| --------------------- | ---- | ------------------------------------------------------------------------- |
| `VALIDATION_ERROR`    | 400  | Field-level Joi failure. See `details`.                                   |
| `BAD_REQUEST`         | 400  | Business-rule violation (e.g., "password in breach", "vehicle required"). |
| `UNAUTHORIZED`        | 401  | Auth missing, invalid, or expired.                                        |
| `FORBIDDEN`           | 403  | Auth OK but wrong role / account deactivated.                             |
| `RESOURCE_NOT_FOUND`  | 404  | Resource doesn't exist or not scoped to this caller.                      |
| `RESOURCE_CONFLICT`   | 409  | Unique constraint (email, invoice, etc.) already in use.                  |
| `RATE_LIMIT_EXCEEDED` | 429  | Too many requests; honor `Retry-After` header.                            |
| `INTERNAL_ERROR`      | 500  | Server-side bug or unexpected failure.                                    |

### Every response includes

- `X-Request-Id` response header — unique ID, log for debugging.

---

## 2. Auth endpoints (🌐 public unless noted)

### POST `/api/auth/register/company`

Register a new company. The account is created in **pending** state — login is blocked until a super admin activates the account (typically after manual payment verification). **No tokens are issued at registration.**

**Headers:** `Content-Type: application/json`

**Body:**

```json
{
  "name": "Sahel Fuel Co.",
  "streetAddress": "12 Avenue de la République",
  "city": "Niamey",
  "state": "Niamey",
  "country": "Niger",
  "postalCode": null,
  "registrationNumber": "RC-12345",
  "contactEmail": "contact@sahelfuel.ne",
  "contactPhone": "+22712345678",
  "whatsappNumber": "+22798765432",
  "businessType": "fuel_station",
  "username": "sahelfuel",
  "email": "admin@sahelfuel.ne",
  "password": "StrongPass123",
  "confirmPassword": "StrongPass123",
  "promoEmailOptIn": true,
  "termsAccepted": true
}
```

**Validation rules:**

- `name`: 2-255 chars
- `streetAddress`: 3-512 chars, required
- `city`: 2-128 chars, required
- `state`: 2-128 chars, required
- `country`: 2-128 chars, required (use the **full country name**, e.g. `"Niger"`, not the ISO code)
- `postalCode`: 1-32 chars, optional (`null` or omitted is fine — Niger and several West African markets don't use postal codes)
- `registrationNumber`: 3-128 chars
- `contactEmail`, `email`: valid email, max 255
- `contactPhone`, `whatsappNumber` (optional): E.164 (`+[1-9]\d{1,14}`)
- `businessType`: exactly `"fuel_station"` or `"shop"`
- `username`: 3-64 chars, `[a-zA-Z0-9_.-]`
- `password`: 8-128 chars, at least one lowercase, one uppercase, one digit
- `confirmPassword`: must equal `password`
- `termsAccepted`: must be `true`

**FE note:** the country/state library you pick (e.g., `country-state-city`) returns full names — pass those through verbatim. Don't strip down to codes.

**Response 201:**

```json
{
  "success": true,
  "message": "Thank you for registering. Once your payment is verified, your account will be activated and you'll be able to log in.",
  "data": {
    "user": {
      "id": "uuid",
      "email": "admin@sahelfuel.ne",
      "username": "sahelfuel",
      "userType": "company",
      "isActive": true
    },
    "company": {
      "id": "uuid",
      "name": "Sahel Fuel Co.",
      "streetAddress": "12 Avenue de la République",
      "city": "Niamey",
      "state": "Niamey",
      "country": "Niger",
      "postalCode": null,
      "registrationNumber": "RC-12345",
      "contactEmail": "contact@sahelfuel.ne",
      "contactPhone": "+22712345678",
      "whatsappNumber": "+22798765432",
      "businessType": "fuel_station",
      "promoEmailOptIn": true,
      "isActive": false,
      "joinedAt": "2026-05-03T10:00:00.000Z",
      "qrToken": "opaque_random_base64url_string"
    }
  }
}
```

**Note:** `user.isActive` is `true` (the auth row is fine), but `company.isActive` is `false` — that's the gate. Login uniformly returns `Invalid credentials` for pending companies.

**Errors:**

- 400 `VALIDATION_ERROR` — field-level Joi errors
- 400 `BAD_REQUEST` — "This password has appeared in a known data breach..."
- 409 `RESOURCE_CONFLICT` — `details` shows which of `email` / `username` / `registrationNumber` collided

**Frontend should:**

- Display the success message verbatim.
- Redirect the user to the **login page**, NOT the dashboard. Do NOT attempt to auto-login (no tokens were issued).
- Optional: show the `qrToken` / `qrUrl` on the success page so the user can preview their QR (it'll be there waiting once they subscribe).
- After login (account is pending, not yet subscribed), the pending-activation screen should direct the user to `/company/billing` to choose a plan and pay.

---

### POST `/api/auth/login`

Log in with email or username.

**Rate limit:** 5 per IP per minute. `skipSuccessfulRequests: true` (only failed attempts count).

**Body:**

```json
{ "identifier": "admin@sahelfuel.ne", "password": "StrongPass123" }
```

`identifier` can be email OR username. Backend detects by presence of `@`.

**Response 200:**

```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": { "id", "email", "username", "userType", "isActive" },
    "companyId": "uuid (only when userType='company')",
    "tokens": { "accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt" }
  }
}
```

**Response 200 shape for pending company (companyIsActive=false):**

```json
{
  "success": true,
  "data": {
    "user": { "id", "email", "username", "userType", "isActive" },
    "companyId": "uuid",
    "companyIsActive": false,
    "tokens": { "accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt" }
  }
}
```

Pending companies now **receive tokens on login** so they can reach the billing page. `companyIsActive: false` signals they haven't subscribed yet.

**Frontend routing after login:**

- `userType = 'super_admin'` → `/admin/dashboard`
- `userType = 'company'` AND `companyIsActive = true` → `/company/dashboard`
- `userType = 'company'` AND `companyIsActive = false` → `/company/billing`

**Errors:**

- 401 `UNAUTHORIZED` "Invalid credentials" — covers user not found / wrong password / inactive user. Show identical UI for all (anti-enumeration).
- 403 `FORBIDDEN` "Your account has been deactivated. Please contact support." — admin-disabled company. Show verbatim.
- 429 `RATE_LIMIT_EXCEEDED` — too many failed attempts.

---

### POST `/api/auth/refresh`

Exchange refresh token for new access + refresh. Old refresh is revoked (rotation).

**Body:** `{ "refreshToken": "..." }`

**Response 200:** same shape as login — includes `companyIsActive` for company users. Use this to re-evaluate routing on app load (e.g., if company subscribed on another device, `companyIsActive` flips to `true` after the next refresh).

**Errors:**

- 401 `UNAUTHORIZED` "Invalid refresh token" — token doesn't exist
- 401 `UNAUTHORIZED` "Session invalidated. Please log in again." — **THEFT DETECTED**. A previously-revoked refresh token was presented. All user sessions have been revoked. Clear all tokens client-side and redirect to login.
- 401 `UNAUTHORIZED` "Refresh token has expired"

---

### POST `/api/auth/logout`

**Body:** `{ "refreshToken": "..." }`

**Response 200:** `{ "success": true, "message": "Logged out", "data": null }`

Idempotent — silent success even if the token was unknown or already revoked.

---

### POST `/api/auth/password-reset/request`

**Rate limit:** 3 per IP per minute.

**Body:** `{ "email": "..." }`

**Response 200 — ALWAYS, regardless of whether the email exists:**

```json
{
  "success": true,
  "message": "If an account exists for this email, a reset link has been sent.",
  "data": null
}
```

Never branch UI based on whether email exists.

---

### POST `/api/auth/password-reset/confirm`

**Body:**

```json
{
  "token": "raw token from the reset URL",
  "newPassword": "NewStrongPass123",
  "confirmNewPassword": "NewStrongPass123"
}
```

**Response 200:**

```json
{
  "success": true,
  "message": "Password has been reset. Please log in again.",
  "data": null
}
```

**Errors:**

- 400 `VALIDATION_ERROR` — Joi violation (including password-mismatch)
- 400 `BAD_REQUEST` — password in HIBP breach corpus
- 401 `UNAUTHORIZED` — token invalid, consumed, or expired

On success: the server revokes ALL refresh tokens for that user. Clear client tokens and redirect to login.

---

### POST `/api/auth/password-change` 🔐

In-app password change for any authenticated user (company OR super admin).

**Headers:** `Authorization: Bearer <accessToken>`, `Content-Type: application/json`

**Body:**

```json
{
  "currentPassword": "OldStrongPass123",
  "newPassword": "NewStrongPass123",
  "confirmNewPassword": "NewStrongPass123"
}
```

**Validation:**

- `currentPassword`: 1-128 chars
- `newPassword`: 8-128 chars, at least one lowercase + one uppercase + one digit
- `confirmNewPassword`: must equal `newPassword`

**Response 200:**

```json
{
  "success": true,
  "message": "Password changed. Please log in again.",
  "data": null
}
```

**Errors:**

- 400 `VALIDATION_ERROR` — Joi violation (including new/confirm mismatch)
- 400 `BAD_REQUEST` "Current password is incorrect"
- 400 `BAD_REQUEST` "This password has appeared in a known data breach..." — HIBP-flagged new password
- 401 `UNAUTHORIZED` — auth missing/expired

**Side effect:** ALL refresh tokens for the user are revoked. After success, clear all client-side tokens and redirect to login (the access token in memory will keep working until it expires, but the user must re-login on every device).

---

## 3. Company endpoints (🏢 requires `userType=company` access token)

**All require:** `Authorization: Bearer <accessToken>`. Automatic 403 if token is for a super_admin or if the company has been deactivated.

### GET `/api/company/profile`

**Response 200:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Sahel Fuel Co.",
    "streetAddress": "12 Avenue de la République",
    "city": "Niamey",
    "state": "Niamey",
    "country": "Niger",
    "postalCode": null,
    "registrationNumber": "RC-12345",
    "contactEmail": "contact@sahelfuel.ne",
    "contactPhone": "+22712345678",
    "whatsappNumber": "+22798765432",
    "businessType": "fuel_station",
    "promoEmailOptIn": true,
    "isActive": true,
    "joinedAt": "2026-05-03T10:00:00.000Z",
    "qrToken": "opaque_string",
    "qrUrl": "http://localhost:5173/qr/opaque_string",
    "subscriptionExpiresAt": "2026-06-23T10:00:00.000Z",
    "currentPlan": {
      "id": "uuid",
      "name": "30 Day Plan",
      "durationDays": 30,
      "price": "850.00",
      "currency": "ZAR"
    }
  }
}
```

`subscriptionExpiresAt` is `null` if the company has never subscribed. `currentPlan` is `null` if no plan has been purchased yet.

**Subscription gate:** data endpoints (`/stats`, `/customers`, `/purchases`) return `403 FORBIDDEN` if `subscriptionExpiresAt` is null or in the past. Profile + billing endpoints are always accessible regardless of subscription status.

### PUT `/api/company/profile`

Update editable company profile fields. Partial update — send only the fields you want to change. Each address sub-field is independently editable (e.g. update just `city` without touching others).

**Headers:** `Authorization: Bearer <accessToken>`, `Content-Type: application/json`

**Body (all fields optional, at least 1 required):**

```json
{
  "streetAddress": "12 Avenue de la République",
  "city": "Niamey",
  "state": "Niamey",
  "country": "Niger",
  "postalCode": null,
  "contactEmail": "newcontact@sahelfuel.ne",
  "contactPhone": "+22712345678",
  "whatsappNumber": "+22798765432",
  "promoEmailOptIn": false
}
```

- `whatsappNumber` accepts `null` or `""` to clear.
- `postalCode` accepts `null` or `""` to clear.

**Validation rules:**

- `streetAddress`: 3-512 chars
- `city`, `state`, `country`: 2-128 chars
- `postalCode`: 1-32 chars or null/empty
- `contactEmail`: valid email, max 255
- `contactPhone`, `whatsappNumber`: E.164 format
- `promoEmailOptIn`: boolean

**Non-editable fields:** `name`, `registrationNumber`, `businessType`, `qrToken`, `isActive`, `joinedAt`. Don't include them. The legacy `address` key is also rejected — Joi `strict()` blocks unknown keys.

**Response 200:** same shape as `GET /api/company/profile` — the full updated profile.

**Errors:**

- 400 `VALIDATION_ERROR` — field violation, empty body (must include at least 1 field), or unknown key (e.g. legacy `address`)

---

### GET `/api/company/stats`

**Response 200:**

```json
{
  "success": true,
  "data": {
    "totalCustomers": 123,
    "totalPurchases": 450,
    "totalSpend": "2345678.50",
    "topSpender": {
      "id": "uuid",
      "fullName": "Amadou Diallo",
      "mobile": "+22798765432",
      "vehicleNumber": "NG-2341",
      "totalInvoiceAmount": "89500.00",
      "submissionCount": 17
    }
  }
}
```

`topSpender` is `null` if the company has zero customers.

### GET `/api/company/customers`

**Query params:**

- `page` (int, default 1)
- `limit` (int, default 10, max 100)
- `search` (string, optional) — ILIKE on mobile / name / vehicle
- `sortBy` — one of: `totalInvoiceAmount` | `submissionCount` | `lastSubmissionAt` | `firstSubmissionAt` (default `totalInvoiceAmount`)
- `sortOrder` — `ASC` | `DESC` (default `DESC`)

**Response 200:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "mobile": "+22798765432",
        "fullName": "Amadou Diallo",
        "vehicleNumber": "NG-2341",
        "totalInvoiceAmount": "89500.00",
        "submissionCount": 17,
        "firstSubmissionAt": "2026-01-15T08:30:00.000Z",
        "lastSubmissionAt": "2026-04-16T14:22:00.000Z",
        "createdAt": "...",
        "updatedAt": "..."
      }
    ],
    "pagination": { "total": 123, "page": 1, "limit": 10, "totalPages": 13 }
  }
}
```

### GET `/api/company/customers/export`

Download all customers for the company as a CSV file (no pagination).

**Headers:** `Authorization: Bearer <accessToken>`

**Response 200:**

- `Content-Type: text/csv`
- `Content-Disposition: attachment; filename="customers.csv"`
- Body: CSV text. All values double-quoted; embedded `"` is escaped as `""`. Line terminator is `\r\n`.

**CSV columns (in order):**
`Full Name`, `Mobile`, `Vehicle Number`, `Total Spend`, `Submission Count`, `First Submission`, `Last Submission`

**Order:** customers are sorted by `totalInvoiceAmount DESC`.

**Frontend usage:**

```js
const res = await fetch(`${API}/api/company/customers/export`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
const blob = await res.blob();
// Trigger download via <a download> or use `file-saver` lib
```

---

### GET `/api/company/customers/:customerId`

**Response 200:** single customer object (same shape as list item).

**Errors:** `404 RESOURCE_NOT_FOUND` if the customer doesn't belong to this company.

### GET `/api/company/purchases`

**Query params:**

- `page`, `limit`, `search` (ILIKE on invoice / name snapshot / vehicle snapshot)
- `customerId` (UUID, optional) — filter by customer
- `from`, `to` (ISO date strings, optional) — date range on `submittedAt`
- `sortBy` — `submittedAt` | `invoiceAmount` (default `submittedAt`)
- `sortOrder` — `ASC` | `DESC` (default `DESC`)

**Response 200:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "invoiceNumber": "INV-00123",
        "invoiceAmount": "5000.00",
        "fullNameSnapshot": "Amadou Diallo",
        "vehicleNumberSnapshot": "NG-2341",
        "submittedAt": "2026-04-16T14:22:00.000Z",
        "ipAddress": "41.x.x.x",
        "userAgent": "Mozilla/5.0 ...",
        "latitude": "13.511500",
        "longitude": "2.125400",
        "locationAccuracy": "12.50",
        "customer": {
          "id": "uuid",
          "mobile": "+22798765432",
          "fullName": "Amadou Diallo",
          "vehicleNumber": "NG-2341",
          "totalInvoiceAmount": "89500.00",
          "submissionCount": 17
        }
      }
    ],
    "pagination": { ... }
  }
}
```

### GET `/api/company/purchases/export`

Download all purchases for the company as a CSV file (no pagination).

**Headers:** `Authorization: Bearer <accessToken>`

**Response 200:**

- `Content-Type: text/csv`
- `Content-Disposition: attachment; filename="purchases.csv"`
- Body: CSV text (same escaping rules as customers export).

**CSV columns (in order):**
`Invoice Number`, `Amount`, `Full Name`, `Vehicle Number`, `Mobile`, `Submitted At`

**Order:** purchases are sorted by `submittedAt DESC`.

---

### GET `/api/company/purchases/:purchaseId`

**Response 200:** single purchase object (same shape as list item).

---

## 4. Super Admin endpoints (👑 requires `userType=super_admin` access token)

> **Note:** Admin can still manually activate/deactivate companies. However, self-service payment is now the primary activation path — manual activation is an override for edge cases.

### GET `/api/admin/stats`

**Response 200:**

```json
{
  "success": true,
  "data": {
    "totalCompanies": 42,
    "activeCompanies": 38,
    "inactiveCompanies": 4,
    "totalFuelStations": 15,
    "totalShops": 27,
    "totalCustomers": 8790,
    "totalPurchases": 31245,
    "totalSpend": "178234567.80"
  }
}
```

### GET `/api/admin/companies`

**Query params:**

- `page`, `limit`
- `search` — ILIKE on name/regNum/email/phone/owner email/owner username
- `status` — `all` | `active` | `inactive` (default `all`). Note: `inactive` covers BOTH pending and deactivated companies. Distinguish them client-side using `deactivatedAt` (see below).
- `businessType` — `all` | `fuel_station` | `shop` (default `all`)

**Three company states (derive from `isActive` + `deactivatedAt`):**
| Display | `isActive` | `deactivatedAt` | Meaning |
|---|---|---|---|
| **Pending** (yellow badge) | `false` | `null` | Newly registered, awaiting admin activation |
| **Active** (green badge) | `true` | (any) | Operational |
| **Deactivated** (red badge) | `false` | not `null` | Admin-disabled after activation |

**Admin actions per state:**

- Pending → "Activate" button (calls `PATCH /activate`)
- Active → "Deactivate" button (calls `PATCH /deactivate`)
- Deactivated → "Activate" button (re-enables them)

**Response 200:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "name": "Sahel Fuel Co.",
        "streetAddress": "12 Avenue de la République",
        "city": "Niamey",
        "state": "Niamey",
        "country": "Niger",
        "postalCode": null,
        "registrationNumber": "...",
        "contactEmail": "...",
        "contactPhone": "...",
        "whatsappNumber": "...",
        "businessType": "fuel_station",
        "isActive": true,
        "joinedAt": "...",
        "deactivatedAt": null,
        "owner": {
          "id": "uuid",
          "email": "...",
          "username": "...",
          "isActive": true,
          "lastLoginAt": "..."
        },
        "createdAt": "...",
        "updatedAt": "..."
      }
    ],
    "pagination": { ... }
  }
}
```

### GET `/api/admin/companies/:companyId`

**Response 200:** single company object **with owner** (same shape as list item).

### PATCH `/api/admin/companies/:companyId/deactivate`

**Response 200:** `{ "success": true, "message": "Company deactivated", "data": null }`

**Side effect:** all refresh tokens for the owner user are revoked. The owner is signed out of every device.

**Errors:** 404 not found, 400 "Company is already deactivated".

### PATCH `/api/admin/companies/:companyId/activate`

**Response 200:** `{ "success": true, "message": "Company activated", "data": null }`

**Errors:** 404 not found, 400 "Company is already active".

---

## 5. Payment & Plans endpoints

### GET `/api/payments/plans` 🌐

List all active subscription plans. Public — no auth.

**Response 200:**

```json
{
  "success": true,
  "data": [
    { "id": "uuid", "name": "7 Day Plan", "durationDays": 7, "price": "300.00", "currency": "ZAR" },
    {
      "id": "uuid",
      "name": "15 Day Plan",
      "durationDays": 15,
      "price": "450.00",
      "currency": "ZAR"
    },
    {
      "id": "uuid",
      "name": "21 Day Plan",
      "durationDays": 21,
      "price": "650.00",
      "currency": "ZAR"
    },
    {
      "id": "uuid",
      "name": "30 Day Plan",
      "durationDays": 30,
      "price": "850.00",
      "currency": "ZAR"
    }
  ]
}
```

Display currency as `R 300.00` or `ZAR 300.00`.

---

### POST `/api/payments/paypal/create-order` 🏢

Create a PayPal order for the selected plan. Returns a PayPal approval URL to redirect to.

**Headers:** `Authorization: Bearer <accessToken>`, `Content-Type: application/json`

**Body:**

```json
{ "planId": "uuid" }
```

**Response 201:**

```json
{
  "success": true,
  "data": {
    "paymentId": "uuid",
    "paypalOrderId": "paypal-order-id-string",
    "approvalUrl": "https://www.sandbox.paypal.com/checkoutnow?token=..."
  }
}
```

**Frontend flow:** after receiving `approvalUrl`, do a **hard redirect**: `window.location.href = approvalUrl`. Do NOT use Next.js router — this is an external URL. PayPal will redirect back to `/company/billing/success?token=<paypalOrderId>` on approval, or `/company/billing/cancel` on cancellation.

**Errors:** 404 plan not found or inactive, 400 missing planId.

---

### POST `/api/payments/paypal/capture-order` 🏢

Capture the PayPal order after the user approves it. Activates the company and sets subscription dates.

**Headers:** `Authorization: Bearer <accessToken>`, `Content-Type: application/json`

**Body:**

```json
{ "paypalOrderId": "paypal-order-id-string" }
```

The `paypalOrderId` comes from the `token` query param on the success return URL: `/company/billing/success?token=<paypalOrderId>&PayerID=...`.

**Response 200:**

```json
{
  "success": true,
  "message": "Payment captured. Your subscription is now active.",
  "data": {
    "paymentId": "uuid",
    "subscriptionStartsAt": "2026-05-24T10:00:00.000Z",
    "subscriptionEndsAt": "2026-06-23T10:00:00.000Z"
  }
}
```

**Idempotent:** safe to call twice for the same order (e.g., if user refreshes the success page). On a second call with the same `paypalOrderId`, returns the same dates.

**Side effects:** `company.isActive = true`, `company.subscriptionExpiresAt` set, `company.currentPlan` set.

**Renewal stacking:** if the company already has a future `subscriptionExpiresAt`, the new plan is stacked on top — the new period starts from the current expiry date, not from today. Fair to early renewers.

**Errors:** 404 payment not found or doesn't belong to this company, 400 payment already failed/cancelled or PayPal did not complete capture.

**After success:** refresh the company profile (`GET /api/company/profile`) to get updated `subscriptionExpiresAt` and `currentPlan`, then redirect to `/company/dashboard`.

---

### POST `/api/payments/paypal/webhook` 🌐

PayPal server-to-server webhook. Handles `PAYMENT.CAPTURE.COMPLETED`. This is a backup path — if the user closes the browser before the frontend calls capture, PayPal notifies the backend directly and the company still gets activated. **Frontend never calls this endpoint directly.** Always responds 200 regardless of outcome.

---

## 6. QR endpoints (🌐 public, no auth)

### GET `/api/qr/:qrToken`

Resolve a QR token to company info for form rendering.

**Params:** `qrToken` — 16-64 chars, `[A-Za-z0-9_-]`.

**Response 200:**

```json
{
  "success": true,
  "data": {
    "companyId": "uuid",
    "companyName": "Sahel Fuel Co.",
    "businessType": "fuel_station",
    "isActive": true
  }
}
```

**Errors:**

- 404 `RESOURCE_NOT_FOUND` — QR not recognized
- 400 `VALIDATION_ERROR` — malformed token

Use `businessType` to decide which form fields to show (vehicleNumber for `fuel_station`, hidden for `shop`). If `isActive=false`, show "Not accepting submissions" and don't render the form.

---

### POST `/api/qr/:qrToken/submit`

Customer purchase submission.

**Rate limits (enforced per `(qrToken, mobile)` in Redis):**

- `QR_SUBMIT_RATE_PER_MINUTE` (default 10/min)
- `QR_SUBMIT_RATE_PER_DAY` (default 50/day)

**Body:**

```json
{
  "mobile": "+22798765432",
  "fullName": "Amadou Diallo",
  "vehicleNumber": "NG-2341",
  "invoiceNumber": "INV-00123",
  "invoiceAmount": 5000.0,
  "latitude": 13.5115,
  "longitude": 2.1254,
  "locationAccuracy": 12.5
}
```

**Field rules:**

- `mobile`: E.164 required
- `fullName`: 2-255 chars, trimmed
- `vehicleNumber`: 2-32 chars, `[A-Za-z0-9-]`, **required for fuel_station, MUST be omitted for shop**
- `invoiceNumber`: 1-64 chars
- `invoiceAmount`: positive number, max 2 decimals, max value = `MAX_INVOICE_AMOUNT` (default 10,000,000)
- `latitude`: -90..90 (optional)
- `longitude`: -180..180 (optional)
- `locationAccuracy`: meters, >= 0 (optional)

**Response 201:**

```json
{
  "success": true,
  "message": "Submission recorded. Thank you!",
  "data": {
    "purchaseId": "uuid",
    "customerId": "uuid",
    "customerTotalInvoiceAmount": "12500.00",
    "customerSubmissionCount": 3,
    "submittedAt": "2026-04-17T10:00:00.000Z"
  }
}
```

**Errors:**

- 400 `VALIDATION_ERROR` — any Joi failure
- 400 `BAD_REQUEST` — "Vehicle number is required for fuel station submissions" / "Vehicle number is not allowed for shop submissions" / "This company is not currently accepting submissions"
- 404 `RESOURCE_NOT_FOUND` — QR not recognized
- 409 `RESOURCE_CONFLICT` — "This invoice number has already been submitted" (server-side pre-check) OR "Resource already exists" (DB unique-constraint fallback)
- 429 `RATE_LIMIT_EXCEEDED` — three causes (all use the same code; FE shows the backend message verbatim):
  - per-minute Redis limiter (10/min default)
  - per-day Redis limiter (50/day default)
  - **15-minute resubmit cooldown** (new 2026-05-03): the same mobile already recorded a successful purchase at this company within the last 15 minutes. Message includes remaining minutes. Tunable via backend env `QR_MIN_RESUBMIT_INTERVAL_MIN`.

---

## 7. Infrastructure endpoints

### GET `/health`

Liveness probe. Returns `{ status: "ok", environment, timestamp }` with 200. Does NOT check dependencies.

### GET `/ready`

Readiness probe. Pings DB + Redis. Returns `{ status, checks: { database, redis } }` with 200 if healthy, 503 otherwise.

---

## 8. Auth flow implementation checklist (frontend)

- [ ] On app load: if refresh token exists in storage, call `/auth/refresh` to get a fresh access token. On failure, clear and route to login.
- [ ] Axios/fetch interceptor: attach `Authorization: Bearer <accessToken>` to every authenticated request.
- [ ] Response interceptor: on 401, attempt ONE refresh; retry original request on refresh success; force-logout on refresh failure.
- [ ] On **login** success (NOT registration): store `accessToken` + `refreshToken`; store `user.userType` for route guards.
- [ ] On **registration** success: do NOT store any tokens (none are returned). Show pending message and route to login page.
- [ ] On logout: call `/auth/logout` with refresh token, then clear storage regardless of response.
- [ ] Route guards: `/company/*` requires `userType='company'`; `/admin/*` requires `userType='super_admin'`.
- [ ] On any "Session invalidated" error (from refresh theft detection) → immediate hard logout + UI message.
- [ ] After **password change** success: clear all tokens and route to login.

---

## 9. Known backend limitations (for frontend planning)

- **No QR image / PDF endpoint yet.** Frontend must render QR client-side from `qrUrl`. PDF download is also client-side (jsPDF recommended).
- **No PDF reports endpoints yet.** "All customers" / "Top 10" PDF downloads are pending. CSV exports of the same data are live.
- **No bulk email for super admin yet.** The email infra is in place; the bulk-email endpoint and audience targeting code are not.
- ~~**No payment integration.**~~ **SHIPPED 2026-05-24.** PayPal self-service subscription is live. Manual admin activation is now an override-only path.

---

## 10. Versioning

This document matches backend code as of **2026-05-24**. If the backend adds new endpoints or changes response shapes, they will update this file. Pull latest before starting a new module.

Contact backend team for questions or if any response shape doesn't match what's documented — we'll patch one side or the other.
