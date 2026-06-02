---
name: be-endpoints
description: Living registry of sena-temp backend API endpoints — routes, auth, request/response shapes. Update when any endpoint is added, changed, or removed.
---

# sena-temp Backend API Endpoints

> Update this file whenever a route is added, modified, or removed. Keep in sync with `src/routes/`.

## Conventions

- Base path: `/api`
- Content-Type: `application/json`
- Auth header (when required): `Authorization: Bearer <access_token>`
- All responses follow the standard shape defined in `BaseController`:
  ```json
  { "success": true/false, "message": "...", "data": {...}, "timestamp": "..." }
  ```
- Error responses include `"error": "<ERROR_CODE>"` and optional `"details": [{ "field", "message" }]`.

## Auth middleware legend

- 🌐 **public** — no auth required
- 🔐 **authenticated** — valid access token required (any user_type)
- 🏢 **company** — access token with `userType = 'company'`
- 👑 **super_admin** — access token with `userType = 'super_admin'`

---

## Endpoints

### 🌐 `POST /api/auth/register/company`

Register a new company in **pending** state. The account is **NOT** auto-activated and **NO tokens are issued**. The company must be activated by a super admin (typically after payment verification) before they can log in.

**Request body:**

```json
{
  "name": "string (2-255)",
  "streetAddress": "string (3-512)",
  "city": "string (2-128)",
  "state": "string (2-128)",
  "country": "string (2-128, full country name)",
  "postalCode": "string (1-32) | null | omitted",
  "registrationNumber": "string (3-128)",
  "contactEmail": "email",
  "contactPhone": "E.164 (+227...)",
  "whatsappNumber": "E.164 | null",
  "businessType": "fuel_station | shop",
  "username": "string (3-64, [a-zA-Z0-9_.-])",
  "email": "email",
  "password": "string (8-128, mix of lower/upper/digit)",
  "confirmPassword": "must match password",
  "promoEmailOptIn": "boolean (default false)",
  "termsAccepted": "true (required)"
}
```

**Response 201:**

```json
{
  "success": true,
  "message": "Thank you for registering. Once your payment is verified, your account will be activated and you'll be able to log in.",
  "data": {
    "user": { "id", "email", "username", "userType", "isActive": true },
    "company": { "id", "name", "streetAddress", "city", "state", "country", "postalCode", "registrationNumber", "contactEmail", "contactPhone", "whatsappNumber", "businessType", "promoEmailOptIn", "isActive": false, "joinedAt", "qrToken" }
  }
}
```

**Note:** `user.isActive` is `true` (the auth row is fine) but `company.isActive` is `false` — this is the gate. Login uses the uniform `Invalid credentials` error when `company.isActive=false`, so pending companies cannot log in.

**Error cases:**

- `400 VALIDATION_ERROR` — any field fails Joi validation
- `400 BAD_REQUEST` — password appears in HIBP breach corpus
- `409 RESOURCE_CONFLICT` — email, username, or registrationNumber already taken

**Transaction boundary:** user insert → company insert — all in one DB transaction. No token issuance.

---

### 🌐 `POST /api/auth/login`

Log in with email OR username + password. Returns access + refresh tokens.

**Rate limit:** 5 per IP per minute (skipSuccessfulRequests), Redis-backed store (survives restart, atomic across instances).

**Request body:**

```json
{ "identifier": "email_or_username", "password": "..." }
```

**Response 200:**

```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": { "id", "email", "username", "userType", "isActive" },
    "companyId": "uuid (when userType=company)",
    "tokens": { "accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt" }
  }
}
```

**Error cases:**

- `401 UNAUTHORIZED "Invalid credentials"` — uniform for user not found / user inactive / wrong password (anti-enumeration)
- `403 FORBIDDEN` with pending-specific copy — password was correct, but company is pending activation (`isActive=false`, `deactivatedAt=null`)
- `403 FORBIDDEN` with deactivated-specific copy — password was correct, but company was deactivated by admin (`isActive=false`, `deactivatedAt!=null`)
- `429 RATE_LIMIT_EXCEEDED` — too many failed login attempts from this IP

State-specific 403 copy only appears after the password is verified, so it doesn't leak whether the email exists.

---

### 🌐 `POST /api/auth/refresh`

Exchange a refresh token for a new access + refresh token pair. One-time-use rotation with theft detection.

**Request body:** `{ "refreshToken": "..." }`

**Response 200:** Same shape as login.

**Security behavior:**

- Old refresh token is revoked; a new one is issued (rotation).
- If a token is presented that's already revoked → **all refresh tokens for the user are revoked** (suspected theft) and the request fails with 401.
- Expired token → 401.

---

### 🌐 `POST /api/auth/logout`

Revoke the given refresh token. Idempotent (silent if token is unknown or already revoked).

**Request body:** `{ "refreshToken": "..." }`

**Response 200:** `{ "success": true, "message": "Logged out", "data": null }`

---

### 🌐 `POST /api/auth/password-reset/request`

Request a password reset link. Always returns 200 (never reveals whether email exists).

**Rate limit:** 3 per IP per minute.

**Request body:** `{ "email": "..." }`

**Response 200:** `{ "success": true, "message": "If an account exists for this email, a reset link has been sent." }`

**Behavior:** If user exists and is active, any prior active reset tokens are consumed and a new one is issued (15-minute TTL, single-use). The reset link is sent via email (BullMQ-queued, nodemailer-SMTP-backed). Email delivery failures are logged but never block the response.

---

### 🌐 `POST /api/auth/password-reset/confirm`

Consume a reset token and set a new password. HIBP-checks the new password. On success, revokes all refresh tokens (forces re-login everywhere).

**Request body:**

```json
{ "token": "...", "newPassword": "...", "confirmNewPassword": "..." }
```

**Response 200:** `{ "success": true, "message": "Password has been reset. Please log in again." }`

**Error cases:**

- `400 BAD_REQUEST` if `newPassword` appears in the HIBP breach corpus
- `401 UNAUTHORIZED` if token is invalid, consumed, or expired
- `400 VALIDATION_ERROR` on shape/password-policy failure

---

## Infrastructure endpoints

### 🌐 `GET /health`

Liveness probe. Returns `{ status, environment, timestamp }`. Not under `/api`.

### 🌐 `GET /ready`

Readiness probe. Pings the database. Returns `200 { status: "ready", checks: { database: "ok" } }` when healthy, `503 { status: "not_ready", checks }` otherwise. Redis check will be added when BullMQ/Redis-backed rate limiting lands.

---

## Company endpoints (🏢 company role)

All endpoints below require a valid access token from a user with `userType = 'company'`. The middleware also loads the associated company and checks `isActive`. Scoped automatically to `req.company.id`.

### 🏢 `GET /api/company/profile`

Returns the logged-in company's profile + QR info.

**Response 200:** `{ data: { id, name, streetAddress, city, state, country, postalCode, registrationNumber, contactEmail, contactPhone, whatsappNumber, businessType, promoEmailOptIn, isActive, joinedAt, qrToken, qrUrl } }`

`qrUrl` is constructed as `${FRONTEND_BASE_URL}/qr/${qrToken}`.

### 🏢 `GET /api/company/stats`

Aggregated stats for the dashboard.

**Response 200:** `{ data: { totalCustomers, totalPurchases, totalSpend, topSpender: { id, fullName, mobile, vehicleNumber, totalInvoiceAmount, submissionCount } | null } }`

### 🏢 `GET /api/company/customers`

Paginated customer list. Query: `page`, `limit`, `search` (mobile/name/vehicle ILIKE), `sortBy` (totalInvoiceAmount | submissionCount | lastSubmissionAt | firstSubmissionAt), `sortOrder` (ASC | DESC).

**Defaults:** `sortBy=totalInvoiceAmount`, `sortOrder=DESC`.

**Response 200:** paginated list via `BaseController.paginationResponse`.

### 🏢 `GET /api/company/customers/:customerId`

Returns a single customer (scoped to this company). `404 RESOURCE_NOT_FOUND` if the customer doesn't belong to this company.

### 🏢 `GET /api/company/purchases`

Paginated purchase list. Query: `page`, `limit`, `search` (invoice/name/vehicle ILIKE), `customerId` (filter by customer), `from`, `to` (ISO date range), `sortBy` (submittedAt | invoiceAmount), `sortOrder`.

Each purchase row includes the joined `customer` relation.

### 🏢 `GET /api/company/purchases/:purchaseId`

Single purchase detail. Scoped to this company; `404` if not found.

---

## Super Admin endpoints (👑 super_admin role)

All endpoints below require a valid access token from a user with `userType = 'super_admin'`. Super admin accounts are created via the `seed:superadmin` CLI (see Bootstrap below).

### 👑 `GET /api/admin/stats`

Platform-wide stats.

**Response 200:** `{ data: { totalCompanies, activeCompanies, inactiveCompanies, totalFuelStations, totalShops, totalCustomers, totalPurchases, totalSpend } }`

### 👑 `GET /api/admin/companies`

Paginated list of all companies. Query: `page`, `limit`, `search` (name/regNumber/email/phone/owner email/owner username), `status` (all | active | inactive), `businessType` (all | fuel_station | shop).

### 👑 `GET /api/admin/companies/:companyId`

Single company detail.

### 👑 `PATCH /api/admin/companies/:companyId/deactivate`

Deactivate a company. Also **revokes all refresh tokens** for the company's owner user → they're logged out everywhere.

**Errors:** `404` not found, `400` already deactivated.

### 👑 `PATCH /api/admin/companies/:companyId/activate`

Reactivate a previously deactivated company. Flips `is_active = true`, clears `deactivated_at` + `deactivated_by`.

**Errors:** `404` not found, `400` already active.

---

## Bootstrap

**Create the first super admin (one-time):**

```bash
npm run seed:superadmin -- --email admin@kimates.com --password 'StrongPass123!'
```

Runs HIBP check by default. Add `--skip-hibp` to bypass (e.g., during local dev on airplane mode).

---

## Customer QR endpoints (🌐 public, no auth)

### 🌐 `GET /api/qr/:qrToken`

Resolve a QR token to the company's minimal info for form rendering.

**Response 200:**

```json
{
  "success": true,
  "data": {
    "companyId": "uuid",
    "companyName": "...",
    "businessType": "fuel_station | shop",
    "isActive": true
  }
}
```

**Errors:** `404 RESOURCE_NOT_FOUND` if QR token doesn't match any company. `400 VALIDATION_ERROR` if token format invalid.

---

### 🌐 `POST /api/qr/:qrToken/submit`

Customer purchase submission. No auth.

**Rate limits (Redis-backed, key = `qrToken + mobile`):**

- `QR_SUBMIT_RATE_PER_MINUTE` (default 10) per `(qrToken, mobile)` per minute
- `QR_SUBMIT_RATE_PER_DAY` (default 50) per `(qrToken, mobile)` per day

**Request body:**

```json
{
  "mobile": "+22712345678",
  "fullName": "Amadou Diallo",
  "vehicleNumber": "NG-2341", // required iff business_type = 'fuel_station'; forbidden for 'shop'
  "invoiceNumber": "INV-00123",
  "invoiceAmount": 5000.0, // capped by env MAX_INVOICE_AMOUNT (default 10,000,000)
  "latitude": 13.5115, // optional (browser geolocation, nullable)
  "longitude": 2.1254, // optional
  "locationAccuracy": 12.5 // optional (meters)
}
```

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

- `404 RESOURCE_NOT_FOUND` — QR not recognized
- `400 BAD_REQUEST` — company deactivated, or business-type mismatch (vehicle required/forbidden)
- `409 RESOURCE_CONFLICT` — invoice number already submitted for this company
- `429 RATE_LIMIT_EXCEEDED` — per-minute / per-day Redis limiter cap hit, OR `(company, mobile)` cooldown active (default 15 min between successful submissions, env-tunable via `QR_MIN_RESUBMIT_INTERVAL_MIN`). Cooldown response message includes remaining minutes.
- `400 VALIDATION_ERROR` — any field fails Joi

**Transactional upsert:** customer row matched by `(company_id, mobile)` for shops / `(company_id, mobile, vehicle_number)` for fuel stations. Aggregates (`total_invoice_amount`, `submission_count`, `last_submission_at`) updated via atomic SQL expressions.

---

---

### 🏢 `PUT /api/company/profile`

Update editable company fields. Each address sub-field is independently editable (partial update).

**Request body (all optional, at least 1 required):**

```json
{
  "streetAddress": "string (3-512)",
  "city": "string (2-128)",
  "state": "string (2-128)",
  "country": "string (2-128)",
  "postalCode": "string (1-32) | null | empty string",
  "contactEmail": "email",
  "contactPhone": "E.164",
  "whatsappNumber": "E.164 | null",
  "promoEmailOptIn": "boolean"
}
```

**Response 200:** Same shape as `GET /api/company/profile`.

**Non-editable fields:** `name`, `registrationNumber`, `businessType`, `qrToken`, `isActive`, `joinedAt`. The legacy `address` key is rejected (Joi `strict()` on unknown keys).

---

### 🔐 `POST /api/auth/password-change`

In-app password change for any authenticated user (company or super_admin).

**Request body:**

```json
{ "currentPassword": "...", "newPassword": "...", "confirmNewPassword": "..." }
```

**Response 200:** `{ "success": true, "message": "Password changed. Please log in again.", "data": null }`

**Behavior:**

- Verifies `currentPassword` against stored hash.
- HIBP k-anonymity check on `newPassword` (fail-open on outage).
- Revokes ALL refresh tokens for the user on success → forces re-login everywhere.

**Errors:** `400` wrong current password, `400` compromised password, `400 VALIDATION_ERROR` on shape failure.

---

### 🏢 `GET /api/company/customers/export`

Export all customers for this company as CSV (no pagination).

**Response 200:** `Content-Type: text/csv`, `Content-Disposition: attachment; filename="customers.csv"`

**CSV columns:** Full Name, Mobile, Vehicle Number, Total Spend, Submission Count, First Submission, Last Submission

---

### 🏢 `GET /api/company/purchases/export`

Export all purchases for this company as CSV (no pagination).

**Response 200:** `Content-Type: text/csv`, `Content-Disposition: attachment; filename="purchases.csv"`

**CSV columns:** Invoice Number, Amount, Full Name, Vehicle Number, Mobile, Submitted At

---

---

## Payment & Plans endpoints

### 🌐 `GET /api/payments/plans`

List all active subscription plans. Public — no auth required.

**Response 200:**

```json
{ "data": [{ "id", "name", "durationDays", "price", "currency" }] }
```

Plans seeded: 7 Day (ZAR 300), 15 Day (ZAR 450), 21 Day (ZAR 650), 30 Day (ZAR 850).

---

### 🏢 `POST /api/payments/paypal/create-order`

Create a PayPal order for the given plan. Returns an approval URL to redirect the user to PayPal.

**Request body:** `{ "planId": "uuid" }`

**Response 201:**

```json
{
  "data": {
    "paymentId": "uuid",
    "paypalOrderId": "string",
    "approvalUrl": "https://www.paypal.com/checkoutnow?token=..."
  }
}
```

**Errors:** `404` plan not found, `400` missing planId.

---

### 🏢 `POST /api/payments/paypal/capture-order`

Capture a previously created PayPal order. On success, company is auto-activated and subscription dates are set. Idempotent — safe to call twice for the same order.

**Request body:** `{ "paypalOrderId": "string" }`

**Response 200:**

```json
{
  "data": {
    "paymentId": "uuid",
    "subscriptionStartsAt": "ISO date",
    "subscriptionEndsAt": "ISO date"
  },
  "message": "Payment captured. Your subscription is now active."
}
```

**Errors:** `404` payment not found or doesn't belong to this company, `400` already failed/cancelled or PayPal did not complete.

**Side effects:** `companies.is_active = true`, `companies.subscription_expires_at = now + plan.durationDays`, `companies.current_plan_id` set, `payments.status = captured`.

---

### 🌐 `POST /api/payments/paypal/webhook`

PayPal webhook endpoint. Handles `PAYMENT.CAPTURE.COMPLETED` — backup path in case the user closes the browser before capture. Verifies PayPal signature via `PAYPAL_WEBHOOK_ID`. Always responds 200 (PayPal retries on non-2xx). Idempotent.

**No auth. Raw body preserved for signature verification.**

---

## Subscription gate

Data routes (`/stats`, `/customers`, `/purchases`) now require `requireActiveSubscription` middleware **in addition to** `companyMiddleware`. Returns `403 FORBIDDEN` if:

- `subscription_expires_at` is NULL (no plan ever purchased)
- `subscription_expires_at < now()` (plan expired)

Profile routes (`GET/PUT /api/company/profile`) are **not** gated — company can always view/edit profile and buy a new plan.

---

## Pending / Planned

- `GET  /api/company/qr/download-pdf` — branded QR poster PDF (BullMQ async)
- `GET  /api/company/reports/all-customers` — async PDF: all customers by cumulative spend
- `GET  /api/company/reports/top-10` — async PDF: top-10 customers (dense-rank, sequential row numbers, FCFS tiebreak — see decision log)
- `POST /api/admin/email/bulk` — super-admin bulk promo email (uses the email worker; needs templates + audience-targeting code)
