# sena-temp — Frontend Flows Guide

> **Audience:** sena-temp frontend team (separate chat/repo).
> **Backend version at time of writing:** Phase 1-6 + PayPal payments. Last updated 2026-05-24.
> **Status:** All flows described here are implemented and ready to integrate.

This document describes WHAT each user journey looks like end-to-end, so the frontend can build the right screens, in the right order, with the right data. For exact request/response shapes, see `FRONTEND_API_GUIDE.md`.

## What changed since 2026-04-17

- **(2026-05-24) PayPal self-service payment integrated.** Companies no longer wait for manual admin activation. After registration, they are redirected to `/company/billing` to choose a plan and pay via PayPal. Account auto-activates on successful capture. New Flow 9 added. Flow 1 and Flow 7 updated. Data routes (`/stats`, `/customers`, `/purchases`) now gated behind active subscription.
- **(2026-05-24) `GET /api/company/profile` now returns `subscriptionExpiresAt` and `currentPlan`.** Use these to drive the plan status widget in the sidebar (replace the hardcoded demo data).

- **(2026-05-03) Password reset emails are now actually delivered.** No FE change required — same generic 200 response, same `?token=...` URL format. Test by requesting a reset and checking the email inbox (instead of asking backend to grep server logs).
- **(2026-05-03) Conflict (`409`) error responses are now per-field friendly messages.** No change to response shape.
- **(2026-05-03) All rate limiters are Redis-backed.** No FE change — same headers, same 429 body.
- **BREAKING (2026-05-03) — Address split into 5 structured fields:** the single `address` string is gone everywhere. New fields: `streetAddress`, `city`, `state`, `country` (all required), `postalCode` (optional/nullable). Affects Flow 1 (Registration form), Flow 5 (Profile/Settings form), and any display surfaces (registration success, settings, admin company detail, future QR PDF poster). FE will use a country-state library (e.g. `country-state-city`) for Country and State dropdowns.
- **BREAKING — Flow 1 (Registration):** companies are now created in **pending** state. No tokens issued. User redirected to login page (not dashboard) and must wait for super admin to activate them. See updated Flow 1 below.
- **NEW — Flow 5 sub-flows:**
  - **Profile edit:** company can update address fields (each independently), contact email/phone, WhatsApp, promo opt-in via `PUT /api/company/profile`.
  - **CSV exports:** company can export all customers / all purchases via `GET /api/company/{customers,purchases}/export`.
- **NEW — Flow 8 (Password Change):** any authenticated user can change their password in-app via `POST /api/auth/password-change`.
- **NEW — Flow 7 (Super Admin):** companies now have **three states** — Pending, Active, Deactivated. Admin sees all three with appropriate actions per state.

---

## Brand & context

- **Working name:** sena-temp (internal)
- **User-facing brand:** KIMates (domain: KIMates.com)
- **Target region:** Niger, West Africa
- **Target language (MVP):** English. French (i18n) layer reserved for later.
- **Currency:** not finalized (display the raw number + a currency label from the backend when provided).

## User roles

| Role                                    | Where they live           | How they sign in                              |
| --------------------------------------- | ------------------------- | --------------------------------------------- |
| **Super Admin**                         | Admin panel (separate UI) | `POST /api/auth/login` with email             |
| **Company** (fuel station / shop owner) | Company dashboard         | `POST /api/auth/login` with email or username |
| **Customer** (end user)                 | Public QR landing page    | No login. Fills the form.                     |

## Global conventions

- **All requests/responses are JSON.** Content-Type: `application/json`.
- **Authenticated endpoints:** `Authorization: Bearer <accessToken>` header.
- **Standard success shape:** `{ success: true, message, data, timestamp }`
- **Standard error shape:** `{ success: false, message, error: "<CODE>", details?: [{ field, message }], requestId?, timestamp }`
- **Error codes to handle:** `VALIDATION_ERROR` (400), `BAD_REQUEST` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `RESOURCE_NOT_FOUND` (404), `RESOURCE_CONFLICT` (409), `RATE_LIMIT_EXCEEDED` (429), `INTERNAL_ERROR` (500).
- **Request correlation:** every response carries `X-Request-Id` header. Log it client-side; include it in bug reports.
- **Rate limits:** when you get `429`, back off. The `Retry-After` header tells you when to retry.
- **Timestamps:** all timestamps are ISO-8601 strings (`2026-04-17T10:00:00.000Z`). Render in the user's local timezone.
- **Numeric money fields** (`totalInvoiceAmount`, `invoiceAmount`) come back as **strings** (e.g., `"5000.00"`) to preserve precision. Use a decimal-safe library (decimal.js, big.js) or display as-is.
- **UUIDs** everywhere for entity IDs. Never generate them client-side; always use what the server returns.
- **Phone numbers** must be in **E.164 format**: `+22712345678` (Niger country code +227). Validate client-side before sending.

---

## Flow 1 — Company Registration (pending activation)

**Purpose:** a new business (fuel station or shop) submits an application. The account is created in **pending** state and CANNOT log in until a super admin activates it (typically after manual payment verification).

**Screens (frontend):**

1. Landing / "Register your business"
2. Registration form (multi-step OR single page — backend doesn't care)
3. **"Pending activation" success screen** — instructs the user to wait for activation; provides a link back to the login page

**Fields to collect:**

- Company: name, registration number, contact email, contact phone, WhatsApp number (optional), business type (radio: Fuel Station | Shop)
- **Address (5 separate inputs):** Country, State/Region, City, Street Address, Postal Code (optional). Use a country/state library to populate Country and State dropdowns; the rest are free text.
- Account: username, email, password, confirm password
- Checkboxes: promo email opt-in (optional, defaults false), terms accepted (required, submit button disabled until checked)

**Validation rules (mirror server-side):**

- Email: valid format, max 255
- Username: 3-64 chars, `[a-zA-Z0-9_.-]` only
- Password: 8-128 chars, must contain at least one lowercase + one uppercase + one digit
- Phone / WhatsApp: E.164 (`+[1-9]\d{1,14}`)
- Registration number: 3-128 chars, any characters
- `streetAddress`: 3-512 chars, required
- `city`, `state`, `country`: 2-128 chars, required
- `postalCode`: 1-32 chars, optional (`null`, empty, or omitted is fine — Niger and several West African markets don't use postal codes; do NOT block submit if empty)
- Terms accepted: MUST be `true`

**Address UX guidance:**

- Country: searchable dropdown populated from the npm library (e.g. `country-state-city`)
- State/Region: searchable dropdown filtered by selected Country
- City: free text (the libraries' city lists are inconsistent; don't block on dropdown)
- Street Address: textarea or single-line text input
- Postal Code: free text, optional. Show as "Postal/ZIP code (optional)"
- Send full names back to the API (`"Niger"`, not `"NE"`).

**Backend does:**

1. Validates input (Joi)
2. **Checks HIBP** — if password appears in known breaches, returns 400. Show the user: "This password has been leaked. Choose a different one."
3. Checks uniqueness of email, username, registrationNumber — returns 409 with `details` array showing which fields collided
4. Creates user (`isActive=true`) + company (`isActive=false`, pending) atomically
5. Returns: user + company (incl. `qrToken`). **No tokens are issued.**
6. Response message: `"Thank you for registering. Once your payment is verified, your account will be activated and you'll be able to log in."`

**Frontend should:**

- **DO NOT store any tokens** (none are returned in the response).
- Display the success message verbatim — instructs the user to wait for payment verification + activation.
- Provide a "Go to login" link / button that routes to the login page.
- Optionally: render the QR code on the success screen from the returned `qrToken` (constructed `${FRONTEND_BASE_URL}/qr/${qrToken}`) so the user can preview their QR. It won't be functional until activation.
- **Do NOT auto-login. Do NOT route to the dashboard.** The user has no valid session.

**Activation lifecycle:**

- After registration → company is **Pending** (`isActive=false`, `deactivatedAt=null`)
- User logs in → sees pending-activation screen → clicks "Choose a Plan" → pays via PayPal → account auto-activates
- Super admin can also manually activate (override path, e.g., for promotions or support cases)

**Login attempts before activation:** the login endpoint returns `403 FORBIDDEN "Your account is awaiting activation. You'll be able to log in once your payment is verified."` — show this verbatim and provide a "Choose a plan" button linking to `/company/billing`. (Note: login is blocked when `company.isActive=false`. The pending-activation page is shown after a successful login attempt that is blocked at the company-state gate — NOT after a wrong password.)

**Pending-activation screen (after login 403):**

- Show the backend 403 message verbatim
- Add a "Choose a Plan →" button that routes to `/company/billing`
- `/company/billing` is accessible to pending companies (no subscription gate on billing routes)

**Common error handling:**

- 400 VALIDATION_ERROR → inline per-field errors (use `error.details[]`)
- 400 BAD_REQUEST "password has appeared in a known data breach" → password field error
- 409 RESOURCE_CONFLICT → per-field collision messages
- 500 → generic "Something went wrong, please try again" + show `requestId` for support

---

## Flow 2 — Company Login

**Screens:** login page (email/username + password).

**Fields:**

- Identifier: email OR username (same field, single input)
- Password

**Behavior:**

- After success: store tokens, redirect to dashboard.
- **Rate limit:** 5 failed attempts per IP per minute. After that, 429 for 60s. Show the countdown if possible.

**After successful login (200):**

| `companyIsActive`           | Where to route                                           |
| --------------------------- | -------------------------------------------------------- |
| (super_admin, field absent) | `/admin/dashboard`                                       |
| `true`                      | `/company/dashboard`                                     |
| `false`                     | `/company/billing` — pending company, needs to subscribe |

Pending companies now receive tokens on login (200, not 403) so they can reach the billing page. The `companyIsActive: false` field in the response is the signal — store it in auth context alongside `companyId`.

**Error categories:**

| HTTP                                                                         | When                                            | What to show                                                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `401 UNAUTHORIZED` "Invalid credentials"                                     | Wrong email/username/password (or unknown user) | Generic UI: "Invalid email or password." Treat all 401s identically — anti-enumeration. |
| `403 FORBIDDEN` "Your account has been deactivated. Please contact support." | Admin disabled the company after activation     | Show the backend message **verbatim**.                                                  |

**Why revealing deactivation state is safe:** the 403 only fires AFTER password verification succeeds — the user has already proven they own the account.

---

## Flow 3 — Password Reset

**Screens:**

1. "Forgot password?" — enter email
2. "Check your email" — always shown regardless of whether the email exists
3. Reset confirmation screen — user clicks email link with `?token=...`, enters new password + confirm

**Backend behavior:**

- Request endpoint **always returns 200** to prevent enumeration. Show the generic "If an account exists, a reset link has been sent" message — always.
- Confirm endpoint validates token, HIBP-checks new password, revokes all refresh tokens for that user. User must log in again after reset.
- Token TTL: 15 minutes. Show expiration to the user.

**Reset URL format:** `{FRONTEND_BASE_URL}/reset-password?token=<raw_token>`. The backend now actually delivers the email via SMTP (nodemailer + BullMQ-queued worker, branded HTML template). If the email queue or SMTP transport fails the API still returns its uniform 200 — the backend logs the failure and the user can re-request.

---

## Flow 4 — Token Lifecycle

**Tokens:**

- **Access token:** JWT, 24h TTL. Sent in `Authorization: Bearer` header on every authenticated request.
- **Refresh token:** opaque, 7d TTL. Sent ONLY to `/auth/refresh` and `/auth/logout` (in body).

**Rotation rules (security-critical):**

- Every successful `/auth/refresh` issues a **new** access + refresh token. The old refresh token is revoked.
- **If a revoked refresh token is presented, the backend revokes ALL refresh tokens for that user.** This is theft detection. The UI should treat this as "session ended, please log in again."
- On 401 from any endpoint, attempt exactly ONE refresh. If refresh also 401s, clear all tokens and redirect to login.

**Suggested frontend pattern:**

```
// Axios interceptor sketch
- On 401 → if not already refreshing:
    - Set refreshing = true
    - POST /auth/refresh with current refresh token
    - On success: update tokens, retry original request
    - On failure: clear tokens, redirect to /login
- On 429: honor Retry-After
```

**Logout:**

- POST `/auth/logout` with the current refresh token — marks that single refresh token revoked.
- Client-side: clear both tokens, redirect to /login.

---

## Flow 5 — Company Dashboard

**Screens:**

1. Dashboard home — stats cards + top spender + QR display
2. Customers list — paginated, searchable, sortable. **"Export CSV" button** → `GET /api/company/customers/export`.
3. Customer detail — name, mobile, vehicle (if fuel), totals
4. Purchases list — paginated, searchable, sortable, filter by customer, date range. **"Export CSV" button** → `GET /api/company/purchases/export`.
5. Purchase detail — invoice, amount, timestamp, ip/user-agent/location (for audit)
6. **Profile/settings — now editable.** `GET /api/company/profile` to view, `PUT /api/company/profile` to save changes. Editable: `streetAddress`, `city`, `state`, `country`, `postalCode`, `contactEmail`, `contactPhone`, `whatsappNumber`, `promoEmailOptIn`. Read-only: `name`, `registrationNumber`, `businessType`, `qrToken`, `joinedAt`, `isActive`. Address inputs use the same dropdown approach as registration. Each address sub-field is independently editable — the user can update just `city` without touching others. Also exposes "Change Password" — see Flow 8.

**Data relationships:**

- Customer has many Purchases
- Purchase belongs to Customer and Company
- Customer aggregates (`totalInvoiceAmount`, `submissionCount`, `lastSubmissionAt`) are pre-computed — don't recompute on the client
- Top spender = customer with highest `totalInvoiceAmount` per company

**UX rules:**

- All paginated lists: default page=1, limit=10, max limit=100
- Default sort for customers: `totalInvoiceAmount DESC` (top spenders first)
- Default sort for purchases: `submittedAt DESC` (newest first)
- Search: client sends raw string, server does ILIKE — debounce 300ms to avoid request spam

**QR display:**

- Profile response includes `qrToken` and `qrUrl`
- Render the QR image client-side from `qrUrl`
- Provide "Download as PDF" — generate client-side (jsPDF or similar) with QR + company name + address
- QR never changes for a given company. Print once, stick on wall.

---

## Flow 6 — Customer QR Purchase Submission (PUBLIC, no auth)

**This is the core product flow.** Customer at a fuel station/shop scans the printed QR code.

**Screens:**

1. QR landing — `/qr/:qrToken` (this page is loaded from the QR scan)
2. Form screen — fields depend on business type
3. Success screen — "Thank you!" + (if confirmed by client) total spend so far

**Flow:**

1. Page loads → call `GET /api/qr/:qrToken` to get `{ companyId, companyName, businessType, isActive }`
   - If `404` → show "QR code not recognized" error
   - If `isActive = false` → show "This business is not currently accepting submissions"
2. Render the form:
   - **All types:** Mobile (E.164 validated), Full Name, Invoice Number, Invoice Amount
   - **Fuel Station only:** Vehicle Number (REQUIRED)
   - **Shop only:** Vehicle Number field HIDDEN
3. Request browser geolocation permission (optional; user can decline). If granted, attach `latitude`, `longitude`, `locationAccuracy` to the submission.
4. Submit → `POST /api/qr/:qrToken/submit`

**Response 201 returns:**

- `purchaseId`, `customerId`
- `customerTotalInvoiceAmount` — their cumulative spend at this company (as a string)
- `customerSubmissionCount` — how many times they've submitted here
- `submittedAt`

**Display to user (confirmed MVP shape pending client):**

- Large "Thank you!" message
- Optional: "You've spent a total of X with this business." (tentative — confirm with client before shipping)

**Errors:**

- 400 VALIDATION_ERROR — field-level Joi errors, render inline
- 400 BAD_REQUEST (business type mismatch) — e.g., trying to submit a vehicle to a shop QR. Shouldn't happen if form renders correctly.
- 404 RESOURCE_NOT_FOUND — QR invalid
- 409 RESOURCE_CONFLICT — invoice number already used at this company. Show: "This receipt has already been recorded. You cannot submit the same invoice twice."
- 429 RATE_LIMIT_EXCEEDED — show the backend message verbatim. Three possible causes:
  - "You have reached the per-minute submission limit..." (10/min Redis limiter)
  - "You have reached today's submission limit for this number..." (50/day Redis limiter)
  - "You've already submitted a receipt at this business recently. Please wait about N more minute(s)..." (15-minute resubmit cooldown per `(company, mobile)`, vehicle-agnostic)

**Client-side UX details:**

- Mobile number input should have a country-code prefix locked to `+227` for Niger, but allow international numbers if the user types `+`.
- Vehicle number: uppercase on blur. Server also uppercases server-side.
- Invoice amount: allow decimal, max 2 places, max value = MAX_INVOICE_AMOUNT (ask backend; default 10,000,000). Show live validation.
- Invoice number: copy the number exactly as printed on the receipt.
- Full name: no strict format; trim on submit.

**Repeat customer UX:**

- First submission from a (mobile, vehicle) pair creates a customer record.
- Subsequent submissions: the customer's name / vehicle get updated to the latest values submitted.
- For same mobile but different vehicle at a fuel station → backend treats as two different customers.

---

## Flow 7 — Super Admin

**Screens:**

1. Admin login (same `/api/auth/login` endpoint)
2. Platform dashboard (stats cards: total companies, active, inactive, total customers, total spend)
3. Companies list (paginated, searchable, filter by status / business type) — **render the three-state badge per row** (see below)
4. Company detail (owner info, timestamps, status badge, action button per state)

**Three company states (most important UX detail):**

| Display            | `isActive` | `deactivatedAt` | What it means                                   | Admin action        |
| ------------------ | ---------- | --------------- | ----------------------------------------------- | ------------------- |
| 🟡 **Pending**     | `false`    | `null`          | Newly registered, awaiting payment verification | "Activate" button   |
| 🟢 **Active**      | `true`     | (any value)     | Operational                                     | "Deactivate" button |
| 🔴 **Deactivated** | `false`    | not `null`      | Admin disabled the company after activation     | "Activate" button   |

The `GET /api/admin/companies` response always includes both `isActive` and `deactivatedAt`. The status filter (`?status=active|inactive`) does NOT distinguish pending vs deactivated — `inactive` returns both. If the admin wants to view only Pending, filter client-side: `isActive=false && deactivatedAt==null`.

**Recommended list UI:**

- Status badge column (3 colors)
- Action button column (`Activate` for pending/deactivated rows, `Deactivate` for active rows)
- Optional: a row of stats at top: `Pending: N | Active: M | Deactivated: K` (compute client-side from current page or call `GET /api/admin/stats`)

**Actions:**

- **Activate** (Pending → Active): calls `PATCH /api/admin/companies/:companyId/activate`. Typical workflow: admin verifies off-platform payment first, then clicks Activate. Show success toast: "Company activated. They can now log in."
- **Deactivate** (Active → Deactivated): confirmation modal first. Backend revokes the owner's refresh tokens → they're logged out everywhere. Show: "Company deactivated. Owner has been signed out of all devices."
- **Re-activate** (Deactivated → Active): same `PATCH /activate` endpoint. Owner must log in again (their tokens were revoked at deactivation).

**Boot-strap note:** the first super admin is created via a CLI script (`npm run seed:superadmin`). Frontend doesn't need to worry about this — it's a one-time backend setup step.

**Payment integration is live (2026-05-24).** The primary activation path is now self-service PayPal payment (Flow 9). The manual "Activate" button is now an **override** — use it for promotions, free trials, or support cases where payment was waived. Keep the button visible; just add a note to the UI: "Activating manually bypasses payment verification." The deactivate flow is unchanged.

---

## Flow 8 — In-App Password Change (any authenticated user)

**Purpose:** logged-in user (company OR super admin) changes their password from the settings page, without going through the email-based reset flow.

**Screens:**

1. Settings page → "Change Password" section / button
2. Form: Current Password, New Password, Confirm New Password
3. Success → toast/banner + force-logout + redirect to login

**Endpoint:** `POST /api/auth/password-change` (requires `Authorization: Bearer <accessToken>`)

**Backend does:**

1. Verifies `currentPassword` against the stored hash → 400 "Current password is incorrect" if wrong
2. HIBP-checks `newPassword` → 400 if compromised
3. Updates the password hash + `password_changed_at`
4. **Revokes ALL refresh tokens for this user** (every device is logged out)

**Frontend should:**

- After 200 response: show a brief success message ("Password changed. Please log in again.")
- Clear all stored tokens (access + refresh)
- Redirect to the login page

**Validation rules (mirror server-side):**

- Current password: 1-128 chars
- New password: 8-128 chars, must include lower + upper + digit
- Confirm new password: must equal new password

**Errors:**

- 400 VALIDATION_ERROR — Joi violations (mismatch, too short, missing complexity)
- 400 BAD_REQUEST "Current password is incorrect" → highlight the current-password field
- 400 BAD_REQUEST "...known data breach..." → highlight the new-password field, prompt for a different one

**Why force re-login:** standard hygiene. If the password change was triggered because of suspected compromise, an attacker may still hold valid refresh tokens elsewhere — invalidating them all closes the loop.

---

## Flow 9 — PayPal Payment & Subscription

**Purpose:** company selects a plan, pays via PayPal, and gets their account activated (or renewed if already active).

**Who can access:** any logged-in company user — pending OR active. The `/company/billing/*` routes must NOT be blocked by the subscription gate.

**Screens:**

### 9a. `/company/billing` — Plan selection

1. Call `GET /api/payments/plans` on load
2. Display 4 plan cards (name, duration, price in ZAR — display as `R 300.00`)
3. If company has an active subscription: show current plan + expiry date + "Renew / Upgrade" heading. If renewing early, mention that remaining days will be preserved (stacking).
4. "Subscribe" / "Choose this plan" button on each card
5. On click → call `POST /api/payments/paypal/create-order` with `{ planId }`
6. Show loading state while the request is in flight
7. On success → **hard redirect**: `window.location.href = approvalUrl`. Do NOT use Next.js router — PayPal URL is external.
8. On error → show error toast and keep the page.

### 9b. `/company/billing/success` — Payment capture

PayPal redirects here after user approves: `?token=<paypalOrderId>&PayerID=...`

1. On page mount: extract `token` from URL query params — this is the `paypalOrderId`
2. Call `POST /api/payments/paypal/capture-order` with `{ paypalOrderId: token }`
3. Show a loading/processing state while waiting (do NOT allow the user to navigate away)
4. On success:
   - Show confirmation: "Payment successful! Your subscription is active until [subscriptionEndsAt date]."
   - Refresh the auth context / company profile to pick up the new `subscriptionExpiresAt` and `isActive=true`
   - Redirect to `/company/dashboard` after 3 seconds (or provide a "Go to dashboard" button immediately)
5. On error:
   - Show error message: "Payment could not be completed. Please try again."
   - Link back to `/company/billing`
   - **Idempotency:** if the user refreshes the success page, the second capture call returns the same result — safe.

### 9c. `/company/billing/cancel` — User cancelled on PayPal

PayPal redirects here if user clicks "Cancel" on the PayPal checkout page.

1. Show message: "Payment was cancelled. No charge was made."
2. Provide a "Try again" link back to `/company/billing`

**Subscription renewal (stacking):**
If the company already has an active subscription (future `subscriptionExpiresAt`), the new plan is stacked on top. The new period starts from the existing expiry date, not from today. So the user doesn't lose remaining days by renewing early. The backend handles this automatically — frontend just shows the returned `subscriptionEndsAt`.

**Sidebar plan status widget:**
Replace the hardcoded demo values with real data from `GET /api/company/profile`:

- `subscriptionExpiresAt` → compute days remaining: `Math.ceil((new Date(subscriptionExpiresAt).getTime() - Date.now()) / 86400000)`
- `currentPlan.name` → plan name label
- If `subscriptionExpiresAt` is null → show "No active plan" + "Subscribe" button → `/company/billing`
- If expired → show "Subscription expired" + "Renew" button → `/company/billing`
- Color thresholds (existing logic): green > 10 days, orange 3-10 days, red < 3 days

**Subscription gate on data routes:**
`/stats`, `/customers`, `/purchases` return `403 FORBIDDEN` if subscription is expired or null. When the frontend receives a 403 on these routes (and the user is authenticated), redirect to `/company/billing` with a toast: "Your subscription has expired. Please renew to continue."

---

## Cross-cutting concerns

### Geolocation (Flow 6)

- W3C `navigator.geolocation.getCurrentPosition()` — free, built-in, requires user consent.
- Timeout ~10s; if denied or timed out, submit without location (backend accepts nullable).
- In indoor fuel-station roofs, GPS accuracy can be poor; that's fine — send what you get.

### Offline / flaky network

- The QR submission endpoint isn't idempotent, but the DB enforces `UNIQUE(company_id, invoice_number)`. A retry of the same payload either succeeds (first time) or returns 409 (already recorded). Treat 409 on retry as "success, already saved."

### Language / i18n

- MVP is English-only. Store all UI strings in a translation file regardless, so French can be dropped in later.

### Pagination contract

- **Every in-app list endpoint is paginated** — `GET /api/admin/companies`, `GET /api/company/customers`, `GET /api/company/purchases`. Default `page=1, limit=10`, max `limit=100`. Response shape: `{ items, pagination: { total, page, limit, totalPages } }`.
- **Bulk-export endpoints are intentionally NOT paginated** — `/customers/export`, `/purchases/export`, and the future PDF reports return ALL records / a fixed-cap result. Trigger them as one-shot downloads.
- Rule of thumb: if you're rendering a scrollable/sortable/searchable table, the endpoint paginates. If the user is downloading a file, it doesn't.

### CORS

- Backend allows origin = `FRONTEND_BASE_URL` from env. Coordinate with backend ops on the production frontend origin.

### Request ID in error toasts

- Every error response has `requestId`. Show it in support-facing UIs: "Error (ID: abc-123...). Please include this code when contacting support."

---

## What's NOT in the backend yet

- **QR PDF download endpoint** — frontend generates PDF client-side for now. When backend adds async PDF via BullMQ, we'll expose `GET /api/company/qr/download-pdf` returning a job ID + an email-delivered link.
- **PDF reports** (all customers by spend, top 10) — same async pattern, pending. CSV exports of the same data ARE available now (`GET /api/company/customers/export`, `GET /api/company/purchases/export`).
- **Bulk email from super admin** — awaiting BullMQ email worker.
- ~~**Email delivery for password reset**~~ — **shipped 2026-05-03.** Reset emails are queued via BullMQ and sent via nodemailer SMTP. Backend env: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`.
- ~~**Payment gateway / subscriptions**~~ — **SHIPPED 2026-05-24.** PayPal self-service subscription live. See Flow 9.
- **Visitor analytics** — endpoint not yet built (`/admin/visitors`).

Ask backend team if any of these become blockers.
