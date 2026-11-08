# sena-temp Backend API Endpoints

> **How to read this file.** An append-only registry; older sections may describe superseded behaviour and say so inline. Where two statements disagree, the later-dated one wins, and `security.md`, `payments-paypal.md` and `lucky-draw.md` win over this file. Last reconciled 2026-11-08.

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

Register a new company. **Current behaviour (trial-first since 2026-07-30; neutral response since 2026-09-14):** no plan is chosen at signup, the response does not log the user in, and it is identical whether or not the email was already taken (the existing owner is notified instead). A verification email is sent; clicking it starts the trial. The paragraphs below that mention tokens in the response or a required plan describe the superseded June flow and are kept for history.

**Response now carries `trial: { eligible, durationDays }`.** `eligible` is advisory — the authoritative decision is made when the verification link is clicked, so it can flip to false if another registration claims the same identifier in between. It deliberately does **not** say which identifier matched; this endpoint is unauthenticated, and naming the field would make it an enumeration oracle over every email and phone number on file.

A repeat email or phone number **never blocks registration** — it only costs the free trial. The company is created, stays `pending`, and lands on the paywall.

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
  "password": "string (8-18, with at least one lowercase letter, one uppercase letter, one number, and one special character)",
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

**Note (historical):** pending companies **can** log in today; access is decided by `computeEntitlement` (see Entitlement / Access Gate in `flows.md`).

**Side effect (2026-07-30):** after the transaction commits, an `email_verification` token is issued and a confirmation email is enqueued. The response gains `emailVerified: false`. The free-trial clock starts on confirmation, not here.

**Rate limit (2026-07-30):** 5 per hour per IP (`registerLimiter`). Previously unlimited apart from the global cap; it now sends mail and dispenses a trial. Deliberately does **not** skip successful requests — successes are the thing being limited.

**Error cases:**

- `400 VALIDATION_ERROR` — any field fails Joi validation
- `409 RESOURCE_CONFLICT` — email, username, or registrationNumber already taken
- `429 RATE_LIMIT_EXCEEDED` — more than 5 registrations from this IP in an hour

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
- **Pending companies CAN log in** (`isActive=false`, `deactivatedAt=null`) — tokens are issued with `companyIsActive: false` so they can reach `/company/billing` and pay.
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

Consume a reset token and set a new password. On success, revokes all refresh tokens (forces re-login everywhere).

**Request body:**

```json
{ "token": "...", "newPassword": "...", "confirmNewPassword": "..." }
```

**Response 200:** `{ "success": true, "message": "Password has been reset. Please log in again." }`

**Password policy:** `newPassword` must be 8–18 characters, with at least one lowercase letter, one uppercase letter, one number, and one special character.

**Error cases:**

- `401 UNAUTHORIZED` if token is invalid, consumed, or expired
- `400 VALIDATION_ERROR` on shape/password-policy failure

---

## Infrastructure endpoints

### 🌐 `GET /health`

Liveness probe. Returns `{ status, environment, timestamp }`. Not under `/api`.

### 🌐 `GET /ready`

Readiness probe. Pings the database **and Redis**. Returns `200 { status: "ready", checks: { database: "ok", redis: "ok" } }` when healthy, `503 { status: "not_ready", checks }` otherwise.

---

## Company endpoints (🏢 company role)

All endpoints below require a valid access token from a user with `userType = 'company'`. Scoped automatically to `req.company.id`.

**Access model (2026-07-30).** `companyMiddleware` loads the company, blocks **only** the admin-deactivated state, and attaches `req.entitlement = computeEntitlement(company, now)`. Routes that need a live subscription add `requireActiveSubscription`, which reads `req.entitlement.hasAccess` and throws **`403 SUBSCRIPTION_REQUIRED`** (distinct from a plain `403 FORBIDDEN`) with `details: [{ field: "subscriptionStatus", message: <status> }]`.

`GET`/`PUT /company/profile` are deliberately **ungated** — an expired company must still reach its profile to render the billing page. Future data-export routes mount on the same ungated side, behind the positive `requireExportAllowed` assertion.

### 🏢 `GET /api/company/profile`

Returns the logged-in company's profile + QR info + the server-computed entitlement block.

**Response 200:** `{ data: { id, name, streetAddress, city, state, country, postalCode, registrationNumber, contactEmail, contactPhone, whatsappNumber, businessType, promoEmailOptIn, isActive, joinedAt, qrToken, qrUrl, subscriptionExpiresAt, currentPlan, hasAccess, subscriptionStatus, accessUntil, trialEndsAt, isTrial, isComped, canExport } }`

`qrUrl` is constructed as `${FRONTEND_BASE_URL}/qr/${qrToken}`.

**`hasAccess` is the only field the frontend route gate should read.** Clients must not re-derive access from `subscriptionExpiresAt` — that check disagreed with the backend on what a null expiry meant and trusted the client clock. `subscriptionStatus` is one of `pending | trialing | active | trial_expired | expired | past_due | deactivated`; `accessUntil` unifies trial/paid/comp end (`null` = perpetual comp or never started).

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
    "isAcceptingSubmissions": true,
    "country": "South Africa"
  }
}
```

**`isAcceptingSubmissions` replaced `isActive` (2026-07-30).** The old flag was the raw `companies.is_active` and ignored subscription expiry, so a lapsed company's scan page rendered a fully working form and the customer only discovered the problem after filling it in and pressing submit. It is now `computeEntitlement(company, now).hasAccess`, matching exactly what `POST /api/qr/:qrToken/submit` will enforce.

Still a `200` rather than an error, so the page can render a branded "not accepting submissions" state. **The reason is never disclosed** — this endpoint is public and unauthenticated.

`country` drives the currency symbol on the customer form.

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

### 👑 Plan management (super admin)

All under `superAdminMiddleware`. **There is deliberately no DELETE** — `payments.plan_id`
and `companies.current_plan_id` are `RESTRICT`, so removing a plan would orphan real
billing records.

| Endpoint                                      | Purpose                                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/plans`                        | All plans including disabled and archived. Each carries `hasPayments` / `hasSubscribers` so the UI can warn before an edit versions the plan. |
| `POST /api/admin/plans`                       | Create. Currency always comes from platform settings, never the request.                                                                      |
| `PATCH /api/admin/plans/:planId`              | Edit. **May return a plan with a different `id`** — see below.                                                                                |
| `PATCH /api/admin/plans/:planId/availability` | `{ isActive }`. Hide from new buyers / put back on sale.                                                                                      |

**The important behaviour:** changing `price` or `durationDays` on a plan that already has
payments or subscribers **archives it and returns a new plan with a new id**. Cosmetic
fields (`name`, `description`, `sortOrder`, `isPopular`) are edited in place, as are
price/duration on a plan that has never been sold. Clients must not assume the returned
`id` matches the one they sent.

**Error cases:**

- `409 RESOURCE_CONFLICT` — disabling the only plan currently on sale
- `400 BAD_REQUEST` — editing or re-enabling an archived plan
- `404 RESOURCE_NOT_FOUND` — unknown plan

### 👑 `GET` / `PATCH /api/admin/settings`

`{ trialDurationDays, platformCurrency }`. Trial length is 1–90 days; currency is a
three-letter code. Changing the trial length affects only trials starting afterwards —
`companies.trial_ends_at` is stamped once when a trial begins.

---

### 🔐 `POST /api/auth/email-verification/resend`

Re-sends the confirmation link to the authenticated user's own address.

**Auth:** `authMiddleware`. Takes **no body** — the address comes from the session, so this endpoint cannot be used to probe which emails exist.

**Rate limit:** 3 per 10 minutes per IP (`emailVerificationResendLimiter`). Each call sends a real email.

**Response 200:** `{ "success": true, "message": "Verification email sent. Please check your inbox.", "data": null }`

Returns the same message whether a mail was sent or the address was already verified. Issuing a new link consumes any previous one — the partial unique index `uq_tokens_active_email_verification` permits only one live token per user.

---

### 🌐 `POST /api/auth/email-verification/confirm`

Consumes a verification link and stamps `users.email_verified_at`.

**Public** — the link is opened from an inbox, possibly in a browser with no session.

**Request body:** `{ "token": "string (20-256)" }`

**Response 200:** `{ "success": true, "message": "Your email has been confirmed.", "data": null }`

**Error cases:**

- `401 UNAUTHORIZED "This verification link is invalid or has expired."` — unknown, consumed, or expired token
- `400 VALIDATION_ERROR` — malformed token. Uses a single generic message for every rule, since a legitimate user only ever pastes a whole link and the specific failure would only help an attacker.

An already-verified user clicking a still-valid link is a no-op success, not an error. TTL is `EMAIL_VERIFICATION_TTL_MIN` (default **1440** = 24h) — deliberately much longer than a password reset, because this is the first message a new customer receives.

**Note:** confirming does **not** by itself grant access. It establishes that the address is real; the free-trial clock is started off the back of it (Phase 3).

---

### 🔐 `POST /api/auth/password-change`

In-app password change for any authenticated user (company or super_admin).

**Request body:**

```json
{ "currentPassword": "...", "newPassword": "...", "confirmNewPassword": "..." }
```

**Response 200:** `{ "success": true, "message": "Password changed. Please log in again.", "data": null }`

**Password policy:** `newPassword` must be 8–18 characters, with at least one lowercase letter, one uppercase letter, one number, and one special character.

**Behavior:**

- Verifies `currentPassword` against stored hash.
- Revokes ALL refresh tokens for the user on success → forces re-login everywhere.

**Errors:** `400` wrong current password, `400 VALIDATION_ERROR` on shape/password-policy failure.

---

## Payment & Plans endpoints

### 🌐 `GET /api/payments/plans`

List all active subscription plans. Public — no auth required.

**Response 200:**

```json
{ "data": [{ "id", "name", "durationDays", "price", "currency" }] }
```

Plans are admin-managed; the list returns every active plan in `sortOrder` with `isPopular`, `description` and `durationDays`.

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

**Validation:** `createOrderSchema` — `planId` must be a UUID. Both PayPal routes had **no schema at all** until 2026-08-03; `{"planId": {"id": 1}}` reached TypeORM, which read the nested object as a relation condition and produced an unhandled 500 on the payment path for any authenticated company.

**Errors:** `400` planId missing / not a UUID, `404` plan not found.

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

**Validation:** `captureOrderSchema` — `paypalOrderId` is `[A-Za-z0-9-]{6,64}`, bounded to the column width so an oversized value is rejected before it reaches the database.

**Errors:** `404` payment not found or doesn't belong to this company, `400` already failed/cancelled or PayPal did not complete.

**Side effects:** `companies.is_active = true`, `companies.subscription_expires_at = now + plan.durationDays` (via the atomic `CompanyRepository.extendSubscription`, which uses `GREATEST(COALESCE(...))` so an early renewal stacks and two concurrent captures cannot lose a paid period), `companies.current_plan_id` set, `payments.status = captured`.

**Concurrency:** the order is claimed with an atomic conditional UPDATE to `status = 'capturing'`; a second concurrent request finds nothing to claim and cannot double-credit. The PayPal HTTP call happens between transactions and holds **no** pool connection.

---

### 🌐 `POST /api/payments/paypal/webhook`

PayPal webhook endpoint. Handles `PAYMENT.CAPTURE.COMPLETED` — backup path in case the user closes the browser before capture. Verifies PayPal signature via `PAYPAL_WEBHOOK_ID`. Idempotent; shares `finalizeCapture` with the synchronous capture path so the two cannot diverge.

**Responds 200 on success and 500 on processing failure — deliberately.** It previously returned 200 unconditionally, so PayPal recorded delivery and never retried: a payment we failed to record was lost silently. A non-2xx is what makes PayPal retry.

**No auth. Raw body preserved for signature verification.**

---

## Subscription gate

Data routes (`/stats`, `/customers`, `/purchases`) now require `requireActiveSubscription` middleware **in addition to** `companyMiddleware`. Returns `403 FORBIDDEN` if:

- `subscription_expires_at` is NULL (no plan ever purchased)
- `subscription_expires_at < now()` (plan expired)

Profile routes (`GET/PUT /api/company/profile`) are **not** gated — company can always view/edit profile and buy a new plan.

---

## Not yet in this registry

Shipped routes documented only in code and in `payments-paypal.md` / `lucky-draw.md` until someone adds them here (run the `sync-docs` skill): `GET /company/draws`, `POST /company/draws/spin`, `POST /payments/spin-addon`, `GET /payments/spin-addon/price`, `GET /payments/history`, invoice PDF download, subscription routes (`/payments/subscriptions/*`, hidden in the UI), QR pause/resume/regenerate, purchase void, email-change request/confirm, admin audit log, admin onboarding/invite, admin lucky-draw settings, `GET /admin/system-status`, `/metrics/visit`.

---

### 🏢 `GET /api/company/export/customers` · `GET /api/company/export/purchases`

Bulk data export. `?format=csv|json` (default `csv`).

**Deliberately NOT paginated** — the documented exemption to the "in-app lists paginate"
rule. A customer taking their data must get all of it; paginating would turn "download
and leave" into a scripted loop. Internally it pages in 1000-row keyset batches so the
pool connection is released between round trips.

**Available when the subscription has lapsed.** Mounted above the
`requireActiveSubscription` block and guarded by `requireExportAllowed`, a positive
assertion of `entitlement.canExport`. The only state that blocks it is `deactivated`
(admin-banned).

**Response:** `text/csv; charset=utf-8` or `application/json; charset=utf-8`, as an
attachment named `kimates-<dataset>-<YYYY-MM-DD>.<ext>`. CSV carries a UTF-8 BOM and
guards spreadsheet-formula payloads. `ip_address`, `user_agent` and raw coordinates are
never included.

**Errors:** `400` unsupported format, `401` unauthenticated, `403` deactivated account.
A failure after the response has begun destroys the connection rather than emitting an
error envelope into a partial file.

---

### 🛡 Admin — subscription & trial controls

All require super-admin auth.

| Endpoint                                               | Purpose                                                                                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/admin/companies/:companyId/trial/extend`    | Grant or extend a free trial. `{ days: 1–365 }`. Stacks onto remaining trial time. Refused on a deactivated company.                                 |
| `PATCH /api/admin/companies/:companyId/comp`           | Set or clear complimentary access. `{ isComped, reason, compedUntil }`. **`reason` is required when granting.** `compedUntil: null` means perpetual. |
| `GET /api/admin/companies/:companyId/trial-identities` | The identifiers this company burned. Masked previews only.                                                                                           |
| `POST /api/admin/trial-identities/:identityId/release` | Hand a burned identifier back. `{ reason }` required. The remedy when a third party burns someone else's email or phone.                             |

Each of these writes the entitlement projection in the same transaction, so the admin
UI reflects the change immediately rather than at the next hourly cron tick.

**Behaviour change on the two existing endpoints:**
`PATCH /companies/:id/deactivate` now guards on `deactivated_at`, not `is_active` — an
expired company can be banned, which it previously could not.
`PATCH /companies/:id/activate` lifts the ban and then re-derives access; it no longer
grants a free subscription to an expired company.

---

### 🏢 `GET /api/company/reports/monthly?year=&month=`

Monthly totals plus the top spenders, aggregated in the database. Requires an active
subscription (it is dashboard data, not an export).

Takes **year and month as numbers**, not an ISO date range — the frontend previously
built the range in local time and `.toISOString()`d it, so in any timezone behind UTC
the report covered the wrong month.

**Response:** `{ from, to, totals: { purchaseCount, totalAmount, uniqueCustomers },
topCustomers: [...] }`. `totalAmount` and `totalSpend` are **strings** — `numeric(14,2)`
through a JS float loses cents.

`topCustomers` is the top ten **plus everyone tied with the tenth** (SQL `RANK()`), which
preserves the behaviour of the client-side implementation it replaces.

**Errors:** `400` on a year outside 2020–2100, a month outside 1–12, or either missing;
`403` if the subscription has lapsed.

---

### 🏢 Account deletion — `GET|POST|DELETE /api/company/deletion-request`

`POST` requests erasure, `DELETE` cancels a pending request, `GET` reports status
(`requested`, `requestedAt`, `purgeAt`, `daysRemaining`).

Guarded by `requireExportAllowed`, not `requireActiveSubscription` — a customer whose
subscription has lapsed must still be able to close their account and take their data.

**7-day grace period (was 30 until 2026-10-03).** Billing stops immediately on request; access does not — the
customer keeps the time they paid for and can export right up to the purge.

The purge **anonymises rather than deletes**: `purchases` and `customers` are erased,
the company and owner rows are scrubbed in place, and `payments`/`subscriptions` are
retained as the money ledger. `trial_identities` survives, so closing an account does not
return a free trial. See decisions.md (2026-08-05) for the full rationale.

---

### 🛡 Admin — account deletion on a customer's behalf

| Endpoint                                                  | Purpose                                                  |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/admin/companies/:companyId/deletion-request`    | Whether a deletion is scheduled, and when it runs.       |
| `POST /api/admin/companies/:companyId/deletion-request`   | Start the 7-day grace period. `{ reason }` **required**. |
| `DELETE /api/admin/companies/:companyId/deletion-request` | Call it off. `{ reason }` **required**.                  |

**Why these exist.** The privacy policy tells customers to request deletion by emailing
support, and every other deletion endpoint sits behind `companyMiddleware` — so it can
only be called by the customer, logged in, which the emailing customer is not. The
promise was unfulfillable and the working code was unreachable by the only party the
policy points at.

`reason` is required because a request that arrived by email has no other record it was
ever made; the audit row is the only evidence. Attributed to the **admin** who pressed
the button, not the customer, so the trail does not claim the customer clicked something
they never saw.

Behaviour is identical to the customer-facing flow: billing stops immediately, access
and export keep working for the full 7 days, and it can be called off until it runs.

---

### 🏢 `GET /api/company/reports/top10.pdf` · `customers.pdf` · `transactions.pdf`

Branded PDF reports, rendered **server-side**.

Gated on `requireExportAllowed` (i.e. `entitlement.canExport`), **not**
`requireActiveSubscription` — the point is that a company whose plan has lapsed can
still take its data. Only an admin ban (`deactivated`) refuses.

| Report             | Orientation | Contents                                                         |
| ------------------ | ----------- | ---------------------------------------------------------------- |
| `top10.pdf`        | portrait    | Top ten by total spend, **top three in bold**, ties share a rank |
| `customers.pdf`    | landscape   | Every customer, highest spend first                              |
| `transactions.pdf` | landscape   | Every purchase, newest first                                     |

Response is the PDF itself — `Content-Type: application/pdf`, `Content-Disposition:
attachment`, `Cache-Control: no-store`. It is **not** wrapped in the standard envelope,
so `ReportController` deliberately does not extend `BaseController`.

Notes:

- Not streamed. A PDF's page count and layout are only known once every row is
  composed, so the document is built in memory. Capped at **5,000 rows**, returning a
  `BAD_REQUEST` with customer-facing copy rather than exhausting the process.
- The vehicle column is omitted entirely for `business_type = 'shop'`, which cannot
  record one.
- The same renderer produces the top-ten PDF attached to the expiry emails, so the
  emailed and downloaded documents are identical.

### 👑 `POST /api/admin/bulk-email`

Send one message to any set of companies and/or arbitrary addresses.

```json
{ "subject": "...", "body": "...", "companyIds": ["uuid"], "extraEmails": ["a@b.com"] }
```

- Either list may be empty, but not both.
- `extraEmails` are deduplicated case-insensitively against the selected companies'
  owner addresses, so nobody receives it twice.
- Delivery goes through the BullMQ email queue, one job per recipient, so a single bad
  address cannot stop the batch.
- Body is escaped before it reaches HTML (`utils/html.ts`) and rendered through the
  branded `bulkAnnouncement` template.

Returns `{ recipientCount, logId }`. `recipientCount` is what was actually queued, not
what was requested.

### 👑 `GET /api/admin/bulk-email/logs?page=&limit=`

Paginated history of every bulk send — subject, body, sender, recipient count, and
which companies it went to.
