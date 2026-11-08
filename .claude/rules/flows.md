# sena-temp Backend Business Flows

> **How to read this file.** Step-by-step flows, appended over time. Sections marked superseded are kept for history; the dated note at the top of each wins. Last reconciled 2026-11-08.

> Document every multi-step flow here with: endpoints, side effects, failure modes, and idempotency guarantees. Update when flows change.

## Status

Live flows. Spin purchases, retention and the aaPanel removal are summarised in `payments-paypal.md`, `lucky-draw.md` and `infrastructure.md`; keep this file for step-by-step flows.

## Flows

### Company Registration (trial-first; the step list below is the superseded June flow)

> **Current flow (2026-07-30 onward):** validate → honeypot and Turnstile → create user + company (pending) in one transaction → after commit, issue an `email_verification` token and enqueue the email → respond with the same neutral message whether or not the email was taken (2026-09-14). **No tokens, no plan.** Verification claims the trial identity (`TrialIdentityService`), starts the trial clock and emails the QR poster PDF; the company pays whenever it likes from Billing. Entitlement decides access (see the Entitlement section at the end).

#### Superseded June 2026 steps

**Trigger:** `POST /api/auth/register/company`

**Steps:**

1. Joi validation (`registerCompanySchema`) — strips unknown fields, normalizes email/phone, rejects if terms not accepted or password mismatch. Password policy: 8–18 characters, with at least one lowercase letter, one uppercase letter, one number, and one special character. The register form requires the customer to have selected a plan.
2. Normalize email to lowercase-trimmed
3. bcrypt hash password (configured rounds)
4. **Inside `AppDataSource.transaction`:**
   a. `assertUniqueIdentifiers()` — parallel check: email, username, registrationNumber. Throws 409 ConflictError if any collision
   b. Insert User: `user_type='company'`, `is_active=true`, `password_changed_at=now`
   c. Insert Company: owner = user, **`is_active=false`** (pending — no `subscription_expires_at` yet), `joined_at=now`, `terms_accepted_at=now`, `qr_token` generated
   d. Issue tokens (auto-login) — signed JWT access + hashed random refresh, ip + userAgent captured
5. Log info with userId + companyId (status: pending company, session issued)
6. Respond 201 with `user`, `company`, `tokens`, `companyId`, and `companyIsActive` (false) + "Registration successful." message

**Side effects:** 1 user row, 1 company row, 1 refresh-token row. All committed atomically. The user is logged in immediately.

**What happens next (frontend):** The user is NOT shown a "wait for activation" screen and does NOT log in separately. Immediately after a successful register, the frontend creates a PayPal order for the chosen plan (`POST /api/payments/paypal/create-order`) and redirects to PayPal. After approval, the user returns to `/company/billing/success`, which captures the order and activates the company (`is_active=true`, `subscription_expires_at` set — see PayPal Payment — Capture below).

**Activation gate:** the company stays `is_active=false` until a payment is captured. The company is the pending entity; the user row is active. Normal activation is via payment, not super-admin action. (A super admin can still deactivate/reactivate — that's a separate path.) Until activated, `companyMiddleware` and the subscription gate block the company's data routes.

**Fallback:** If PayPal is abandoned or order creation fails, the company stays PENDING and the user remains logged in — they can pay later from `/company/billing`.

**Three states a company can be in:**

- **Pending** — `is_active=false`, `deactivated_at=null` (newly registered, never activated)
- **Active** — `is_active=true`
- **Deactivated** — `is_active=false`, `deactivated_at!=null` (admin disabled after activation)

**Failure modes:**

- Validation fails → 400 VALIDATION_ERROR
- Uniqueness collision (pre-check) → 409 RESOURCE_CONFLICT with per-field details
- DB unique constraint race → handled by global error handler via `QueryFailedError` (code 23505) → 409
- Any step inside transaction throws → full rollback, no partial state

**Idempotency:** Not idempotent by design (no idempotency key on registration). Safe because uniqueness checks + DB constraints prevent duplicates.

**Audit trail:** `users.password_changed_at`, `companies.joined_at`, `companies.terms_accepted_at`.

### Login

**Trigger:** `POST /api/auth/login`

**Steps:**

1. Per-IP rate limit (5/min, skipSuccessfulRequests) — 429 if exceeded
2. Joi validates `{ identifier, password }`
3. Detect email vs username by presence of "@"; normalize email (lowercase + trim)
4. Load user with password column (`findByEmailWithPassword` or username → email → with-password lookup)
5. **Pre-password gate (anti-enumeration):** if user missing / `user.isActive=false` / wrong password → `UnauthorizedError("Invalid credentials")`. Same uniform message for all three.
6. **Post-password company gate (state-specific copy):** once password is verified, the caller has proven they own the account, so revealing company state is no longer a leak:
   - No company row found (shouldn't happen) → `UnauthorizedError("Invalid credentials")`
   - Company **pending** (`isActive=false` AND `deactivatedAt=null`) → tokens issued, `companyIsActive: false` in response. Frontend routes to `/company/billing`.
   - Company **deactivated** (`isActive=false` AND `deactivatedAt!=null`) → `ForbiddenError("Your account has been deactivated. ...")` (403)
7. **Inside transaction:**
   a. Issue tokens (signed JWT access + hashed random refresh, ip + userAgent captured)
   b. `users.last_login_at = now()`

**Failure modes:**

- Rate limit → 429 RATE_LIMIT_EXCEEDED
- Wrong identifier or password → 401 UNAUTHORIZED `"Invalid credentials"` (uniform)
- Pending company → **not blocked**: tokens are issued with `companyIsActive: false` so they can reach `/company/billing` and pay
- Deactivated → 403 FORBIDDEN with deactivated-specific copy

**Why the deactivated copy is safe here:** the state branch only runs AFTER password verification succeeds. Password-spraying / enumeration attempts hit `Invalid credentials` 99.9%+ of the time and never reach this branch. The legitimate (deactivated) user gets clear guidance instead of a confusing "Invalid credentials" they can't act on.

**Audit trail:** `users.last_login_at` + refresh-token row has `ip_address` + `user_agent`.

---

### Refresh token (with rotation + theft detection)

**Trigger:** `POST /api/auth/refresh`

**Steps (all inside one transaction):**

1. Hash the incoming `refreshToken` (SHA-256)
2. Find refresh token row by hash (any state — not filtered by revoked/expired)
3. If not found → 401 "Invalid refresh token"
4. **If `revoked_at` is NOT NULL → theft suspected:** revoke ALL refresh tokens for that user, log warn, 401
5. If `expires_at <= now()` → 401 "expired"
6. Load user; if missing or inactive → 401
7. Revoke the presented token (one-time-use)
8. If company user, verify company exists and is active
9. Issue NEW access + refresh token pair (rotation)

**Security guarantee:** a stolen refresh token has a blast radius of one refresh cycle. After the legitimate client refreshes once, the stolen copy is dead weight and its reuse triggers full session invalidation.

---

### Logout

**Trigger:** `POST /api/auth/logout`

**Steps:**

1. Hash the incoming `refreshToken`
2. Find the refresh token by hash
3. If found and not already revoked, set `revoked_at = now()`
4. Silent success regardless (idempotent)

Access tokens are NOT invalidated — JWT is stateless. They expire naturally (24h default). Acceptable given refresh rotation limits the blast radius.

---

### Password Reset — Request

**Trigger:** `POST /api/auth/password-reset/request`

**Steps:**

1. Per-IP rate limit (3/min, Redis-backed) → 429 if exceeded
2. Joi validates `{ email }`, normalizes to lowercase
3. **Always respond 200** with generic message — never reveal whether email exists
4. If user exists and is active:
   a. Transactional: invalidate all prior active password_reset tokens for user (`invalidateActivePasswordResets`) + create new token row (SHA-256 hash stored, 15-min TTL, ip + userAgent captured)
   b. **Enqueue email** via `EmailService.enqueuePasswordReset({ to, resetToken, expiresInMinutes })` → BullMQ job `email/passwordReset` → worker renders branded HTML template + sends via nodemailer SMTP. URL format: `${FRONTEND_BASE_URL}/reset-password?token=<raw>`.
   c. Email-queue failures are caught + logged but do NOT block the response (the user can re-request).

**Security:** Partial unique index `UNIQUE(user_id) WHERE type='password_reset' AND consumed_at IS NULL` guarantees at most one active reset at a time.

---

### Password Reset — Confirm

**Trigger:** `POST /api/auth/password-reset/confirm`

**Steps:**

1. Joi validates `{ token, newPassword, confirmNewPassword }` + strict `valid(Joi.ref("newPassword"))`. Password policy: 8–18 characters, with at least one lowercase letter, one uppercase letter, one number, and one special character.
2. Hash incoming `token` (SHA-256) → find USABLE password_reset token (not consumed, not expired)
3. If not found → 401 "Reset token is invalid or has expired"
4. Load user; if missing or inactive → 401
5. **Transactional:**
   a. bcrypt-hash new password, update `users.password` + `users.password_changed_at = now()`
   b. Mark reset token `consumed_at = now()`
   c. **Revoke ALL refresh tokens for the user** — forces re-login on every device (post-reset hygiene)

**Failure modes:** expired/invalid token, inactive user — all surfaced with appropriate status codes.

---

### Company Dashboard (read-only)

**Triggers:** `GET /api/company/profile`, `/stats`, `/customers`, `/customers/:id`, `/purchases`, `/purchases/:id`

**Auth:** `companyMiddleware` (requires JWT + `userType='company'` + active company)

**Scope:** all queries auto-scoped by `req.company.id`. No endpoint can leak another company's data.

**Failure modes:**

- 401 if JWT invalid / user inactive
- 403 if user is not of `userType='company'` or company deactivated
- 404 if the customer/purchase doesn't belong to this company
- 400 on validation errors (bad page/limit/sort values)

---

### Super Admin — Deactivate Company

**Trigger:** `PATCH /api/admin/companies/:companyId/deactivate`

**Steps (inside a single DB transaction):**

1. Load company with owner relation
2. If not found → 404. If already deactivated → 400.
3. Set `is_active = false`, `deactivated_at = now()`, `deactivated_by = adminUserId`.
4. Revoke ALL refresh tokens for company owner user (owner is instantly logged out from every device).
5. Log the action with `companyId, adminUserId, ownerUserId`.

**Invariant:** after commit, the affected company's owner cannot obtain new access tokens via refresh (all refresh tokens revoked). Existing access tokens expire within their 24h window; next request after expiry fails the `companyMiddleware` `isActive` check.

---

### Super Admin — Activate Company

**Trigger:** `PATCH /api/admin/companies/:companyId/activate`

**Steps:**

1. Load company
2. If not found → 404. If already active → 400.
3. Set `is_active = true`, clear `deactivated_at`, `deactivated_by`.

Owner must re-log-in if they were logged out when deactivated (their refresh tokens were revoked at that time).

---

### Customer QR Submission

**Trigger:** `POST /api/qr/:qrToken/submit` (public, no auth)

**Pre-request middleware chain:**

1. `validateRequest` on params — `qrToken` format check
2. `validateRequest` on body — mobile (E.164), name, optional vehicleNumber, invoiceNumber, invoiceAmount (≤ `MAX_INVOICE_AMOUNT`), optional geolocation
3. `qrSubmitPerMinuteLimiter` — Redis INCR, key `rl:qr_submit_min:${qrToken}:${mobile}:m`
4. `qrSubmitPerDayLimiter` — Redis INCR, key `rl:qr_submit_day:${qrToken}:${mobile}:d`

**Service steps (inside one DB transaction):**

1. `companyRepository.findByQrToken(qrToken)` — if not found → 404
2. If company inactive → 400
3. `assertBusinessTypeFields` — fuel station REQUIRES `vehicleNumber`, shop FORBIDS it
4. Normalize: mobile trim, fullName trim, vehicleNumber uppercase trimmed, invoiceNumber trim
5. **`assertResubmitCooldown(company.id, mobile)`** — `customerRepository.findMostRecentByCompanyAndMobile` returns the latest customer row for `(company, mobile)` regardless of vehicle. If `last_submission_at` is within `QR_MIN_RESUBMIT_INTERVAL_MIN` (default 15 min), throws `429 RATE_LIMIT_EXCEEDED` with remaining minutes in the message. Skipped for first-time customers.
6. `purchaseRepository.findByCompanyAndInvoice(company.id, invoiceNumber)` — if found → 409
7. `customerRepository.findByCompanyAndMobile(company.id, mobile, vehicleNumber)` — identity match:
   - Shop: `(company_id, mobile)` with `vehicle_number IS NULL`
   - Fuel: `(company_id, mobile, vehicle_number)` — same vehicle = same customer
8. If customer exists: update `full_name`, `vehicle_number`, `last_submission_at` (Option B overwrite)
9. If customer is new: create with initial aggregates (`total=0`, `count=0`)
10. Create `purchase` row with snapshot fields + forensics (ip, user_agent, lat/lng/accuracy)
11. Atomic aggregate update: `total_invoice_amount = total_invoice_amount + <amount>`, `submission_count = submission_count + 1`, `last_submission_at = now`
12. Re-read customer for fresh aggregates to include in response

**DB-level guardrails:**

- `UNIQUE(company_id, invoice_number)` on `purchases` — belt+suspenders beyond the pre-check
- Partial unique indexes on `customers` (shop vs fuel) enforce identity integrity
- Any violation → 23505 → caught by global error handler → 409

**Side effects:**

- 1 new `purchase` row always
- 1 new `customer` row OR 1 updated customer row
- Rate-limit counters incremented in Redis

**Failure modes + responses:**

- QR invalid → 404
- Company deactivated → 400
- Business-type field mismatch → 400
- Cooldown active (mobile submitted at this company within last `QR_MIN_RESUBMIT_INTERVAL_MIN` minutes) → 429 with remaining-minutes message
- Duplicate invoice → 409 (via pre-check, or 23505 fallback)
- Per-minute / per-day rate limit hit → 429 with human-readable message
- DB transaction rollback on any step failure

**Idempotency:** Not idempotent (no idempotency key), but `UNIQUE(company_id, invoice_number)` makes retries safe — a retry of the same invoice either goes through (first time) or returns 409 (already recorded).

**Audit trail:** `purchases.ip_address`, `purchases.user_agent`, `purchases.latitude/longitude/location_accuracy`, `purchases.submitted_at`, plus immutable name/vehicle snapshots.

---

### QR Resolution (public preview)

**Trigger:** `GET /api/qr/:qrToken`

**Steps:**

1. Validate token format
2. `companyRepository.findByQrToken(qrToken)` — 404 if not found
3. Return `{ companyId, companyName, businessType, isActive }` — minimal info for the frontend to render the form (field list changes by business type)

No rate limit on resolve — it's a safe, cacheable GET with minimal info.

---

_Each flow will be documented as it is implemented, using this template:_

```
### <Flow Name>
**Trigger:** <endpoint or event>
**Steps:**
  1. ...
**Side effects:** <db writes, emails queued, tokens issued>
**Failure modes:** <what can go wrong, how we recover>
**Idempotency:** <is it safe to retry?>
**Audit trail:** <what is logged>
```

### Company Profile Edit

**Trigger:** `PUT /api/company/profile`

**Steps:**

1. `companyMiddleware` — validates JWT, loads company, checks `isActive`
2. Joi validates body — all fields optional, `.min(1)` enforces at least one field present
3. `CompanyService.updateProfile` — builds partial update object from defined fields only, calls `CompanyRepository.updateProfile`, re-fetches and returns the full profile

**Editable:** `streetAddress`, `city`, `state`, `country`, `postalCode`, `contactEmail`, `contactPhone`, `whatsappNumber`, `promoEmailOptIn`

**Failure modes:** `400 VALIDATION_ERROR` on shape failure (or unknown key like legacy `address`), `401/403` via middleware.

---

### In-App Password Change

**Trigger:** `POST /api/auth/password-change`

**Steps:**

1. `authMiddleware` — any authenticated user (company or super_admin)
2. Joi validates `{ currentPassword, newPassword, confirmNewPassword }`. `newPassword` policy: 8–18 characters, with at least one lowercase letter, one uppercase letter, one number, and one special character.
3. Load user with password hash via `findByIdWithPassword`
4. Verify `currentPassword` against stored hash — 400 if wrong
5. **Transactional:** bcrypt-hash new password → `updatePasswordChanged` + `revokeAllRefreshTokensForUser`

**Side effects:** All refresh tokens revoked → user must re-login on every device.

---

### PayPal Payment — Initiate

**Trigger:** `POST /api/payments/paypal/create-order`

**Steps:**

1. `companyMiddleware` — JWT + active company
2. Validate `planId` present
3. `PlanRepository.findById` — 404 if not found or inactive
4. `PaypalService.createOrder` — POST to PayPal Orders API v2 with amount/currency/referenceId + return/cancel URLs
5. Extract `approve` link from PayPal response
6. `PaymentRepository.create` — save pending payment row (paypalOrderId, status=pending, amount, currency)
7. Return `{ paymentId, paypalOrderId, approvalUrl }`

**Side effects:** 1 `payments` row (status=pending). No company change yet.

---

### PayPal Payment — Capture

**Trigger:** `POST /api/payments/paypal/capture-order`

**Steps:**

1. `companyMiddleware`
2. Validate `paypalOrderId` present
3. `PaymentRepository.findByPaypalOrderId` — 404 if not found or belongs to different company
4. Idempotency: if already `captured`, return existing subscription dates immediately
5. If status is not `pending` → 400
6. `PaypalService.captureOrder(paypalOrderId)` — POST to PayPal capture endpoint
7. If PayPal capture status ≠ `COMPLETED` → update payment to `failed`, throw 400
8. Compute subscription dates: `startsAt = now`, `endsAt = now + plan.durationDays`
9. **Transaction:**
   a. `PaymentRepository.updateCaptured` — status=captured, capturedAt, subscriptionStartsAt/EndsAt, paypalResponse (full JSON)
   b. `Company.update` — isActive=true, currentPlan, subscriptionExpiresAt=endsAt, deactivatedAt=null
10. Return `{ paymentId, subscriptionStartsAt, subscriptionEndsAt }`

**Renewal (stacking):** If company already has a future `subscriptionExpiresAt`, the new plan is stacked on top — the new period starts from `currentExpiresAt`, not from `now`. Formula: `base = max(now, currentExpiresAt); endsAt = base + durationDays`. Fair for early renewers — remaining days are preserved.

**Side effects:** payment row captured, company activated, subscription window set.

---

### PayPal Webhook — PAYMENT.CAPTURE.COMPLETED

**Trigger:** `POST /api/payments/paypal/webhook` (public, PayPal-signed)

**Steps:**

1. `PaypalService.verifyWebhookSignature` — calls PayPal verify API; on failure, log warn + return (no error thrown — always 200)
2. Parse body, check `event_type === "PAYMENT.CAPTURE.COMPLETED"`
3. Extract `paypalOrderId` from event resource
4. `PaymentRepository.findByPaypalOrderId` — if not found, log warn + return
5. Idempotency: if already `captured`, return
6. Same capture + company activation transaction as the capture endpoint
7. Always respond 200

**Purpose:** Backup for cases where the user closes the browser between PayPal redirect and frontend calling capture.

---

### Email Verification

**Issued at:** registration, **after the transaction commits** (a rollback must not
leave a "welcome, confirm your email" already sent, and a Redis outage must not fail
an otherwise-valid signup). Re-issued on demand via the authenticated resend endpoint.

1. `generateRandomToken(32)` → SHA-256 hash stored on a `tokens` row of type
   `email_verification`, TTL `EMAIL_VERIFICATION_TTL_MIN` (default 1440 min = 24h)
2. Any outstanding verification token for that user is consumed first — the partial
   unique index allows only one live token per user
3. `EmailService.enqueueEmailVerification` → BullMQ → worker → SMTP.
   Link: `${FRONTEND_BASE_URL}/verify-email?token=<raw>`
4. Enqueue failure is logged and swallowed; the API still succeeds and the user can resend

**Confirm** (`POST /auth/email-verification/confirm`, public):
look up by hash where `consumed_at IS NULL AND expires_at > NOW()` → consume the token →
stamp `users.email_verified_at` if not already set. Re-clicking a consumed link fails
closed with the same generic message as an invalid one.

**Verification does not grant access.** It only establishes that the address is real.
The trial clock is started off the back of it in Phase 3, which is why time spent in
an inbox is never charged against the trial.

---

### Entitlement / Access Gate

> Rewritten 2026-07-30. The previous version of this section described a null
> `subscriptionExpiresAt` as returning 403 "no active subscription" — but the code
> actually called `next()` and let it through as an admin free-override, and the
> frontend gate did something different again. Three descriptions, three behaviours.
> That is what this rework eliminates.

**Single source of truth:** `computeEntitlement(company, now)` — `src/utils/entitlement.ts`.
Pure, DB-free, called in real time on every request. Returns `{ status, hasAccess, isTrial, endsAt, canExport }`.

**Precedence (strict):**

1. `!isActive && deactivatedAt != null` → `deactivated` — no access, **no export**
2. `isComped && (compedUntil == null || compedUntil > now)` → `active` — the explicit admin override
3. `subscriptionExpiresAt > now` → `active`
4. `trialEndsAt > now` → `trialing`
5. `subscriptionExpiresAt != null` (past) → `expired`
6. `trialEndsAt != null` (past) → `trial_expired`
7. else → `pending`

Paid is checked before trial so converting mid-trial can never downgrade the status.
`canExport` is true in every state except `deactivated`.

**Where it is applied:**

| Layer                       | Behaviour                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `companyMiddleware`         | Blocks only `deactivated`. Attaches `req.entitlement`. Does **not** check `isActive`.                 |
| `requireActiveSubscription` | `403 SUBSCRIPTION_REQUIRED` unless `hasAccess`. Applied to `stats`, `customers`, `purchases`.         |
| `requireExportAllowed`      | Positive assertion on `canExport`, for the (Phase 5) export routes.                                   |
| `GET/PUT /company/profile`  | Ungated by design — an expired company must reach its profile to render billing.                      |
| Payment routes              | `companyMiddleware` only, so pending/expired companies can pay.                                       |
| `QrService.resolveByToken`  | Returns `isAcceptingSubmissions = hasAccess`. 200, reason never disclosed.                            |
| `QrService.submitPurchase`  | Rejects unless `hasAccess`.                                                                           |
| Login / refresh             | **Unchanged** — blocks only true deactivation. Expired users must be able to log in to pay or export. |

**`companies.subscription_status` is never read by any of the above.** It is a projection maintained by the (Phase 4) expiry cron for indexed queries and UI badges only, so a stalled cron can never revoke access from a paying customer.

`subscriptionExpiresAt = null` means **no paid subscription has ever been purchased** — never "unlimited access". Unlimited access is `is_comped`.

---

## Flows documented elsewhere

Spin purchase and capture → `payments-paypal.md` and `lucky-draw.md`. Expiry notices, purge and account deletion → `payments-paypal.md` (Retention) and `decisions.md` (2026-08-04, 2026-08-05, 2026-10-03). Bulk email → `endpoints.md`. QR pause/resume/regenerate, purchase void, email change, admin onboarding: in code only; add here when touched (`sync-docs`).
