# sena-temp Backend Decision Log

> One row per decision. Format: **Date · Decision · Why · Alternatives considered · When to revisit.**
> Two sections: **Locked** (decided + to be implemented) and **Pending** (awaiting input or deferred to later phase).

---

## Pending decisions / open questions

| #   | Topic                                                                                   | Status                                                                         | Awaiting / Revisit trigger                         |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| P1  | Email verification on company registration                                              | **Resolved (2026-07-30) — required; gates the trial clock**                    | —                                                  |
| P2  | Mobile number verification via SMS OTP                                                  | Awaiting client confirmation                                                   | User to confirm with client                        |
| P3  | Submission success response shape (just "Thank you" vs include cumulative spend + rank) | Awaiting client confirmation                                                   | User to confirm with client                        |
| P4  | Payment gateway (Flutterwave vs alternative)                                            | Resolved (2026-06-07) — PayPal (Orders API)                                    | —                                                  |
| P5  | Plan structure (fixed 15/30 vs custom lengths, pricing, currency USD/XOF)               | **Resolved (2026-08-03) — admin-managed, versioned; single platform currency** | —                                                  |
| P6  | QR code PDF layout (branding, size, QR placement)                                       | Design decision                                                                | Phase 4                                            |
| P7  | System message language (English only vs bilingual EN+FR)                               | Resolved — English only (no i18n; next-intl removed)                           | —                                                  |
| P8  | Password policy strengthening via haveibeenpwned range-query API (free)                 | Removed (2026-06-07)                                                           | HIBP removed; see superseded decision below        |
| P9  | JWT key rotation / versioning strategy                                                  | Keep in consideration                                                          | Before first production deploy                     |
| P10 | Column-level PII encryption (envelope pattern)                                          | Future improvement                                                             | When scaling beyond small pilot                    |
| P11 | Failed-login tracking + account lockout                                                 | Improvement phase                                                              | After MVP, before public launch                    |
| P12 | Compliance: privacy policy, retention policy, right-to-be-forgotten process             | Post-dev review                                                                | Before first real company onboards                 |
| P13 | Cursor-based pagination migration                                                       | Optimization trigger                                                           | When any single company exceeds ~50K purchases     |
| P14 | Time-based partitioning on `purchases` table (monthly)                                  | Scale planning                                                                 | Before total purchase count hits 10M               |
| P15 | Read replica for report generation                                                      | Scale planning                                                                 | Post-MVP, when report latency matters              |
| P16 | Circuit breakers (opossum or similar) around external calls                             | Integration-dependent                                                          | When integrating payment gateway or 3rd-party APIs |
| P17 | Column-level PII encryption                                                             | Security hardening                                                             | Before scaling to many companies                   |
| P18 | Dockerfile + docker-compose + CI/CD pipeline                                            | Deployment prep                                                                | At deployment time                                 |

---

## Locked decisions (to implement)

### 2026-08-03 · Plans are admin-managed and versioned, never repriced in place (closes P5)

**Decision:** Super admins can create plans, edit them, and enable/disable them, and can change the free-trial length — all without a deploy. Resolves pending question **P5** (plan structure / pricing / currency).

**Trial length is 7 days**, stored in `app_settings.trial_duration_days`. `config.TRIAL_DURATION_DAYS` is now only a seed value and a fallback if the table can't be read — **never read it directly, use `SettingsService`**. Changing the setting affects only trials that start afterwards, because `companies.trial_ends_at` is stamped once when the trial begins. Moving 7 → 14 → 15 is a number in a form, not a code change.

**The core rule: editing a plan's price or duration creates a NEW plan and archives the old one.** Cosmetic fields (name, description, sort order, popular badge) are edited in place.

Two reasons, both non-negotiable:

1. `payments.plan_id` references the plan row. Mutating a price rewrites history — a receipt for a R250 purchase would start claiming R300. That surfaces in a dispute.
2. **PayPal billing plans are immutable.** A price change there requires a new PayPal plan. Mutating our row would put us permanently out of sync with them once Phase 6 lands.

Exception: a plan with **no** payments and **no** current subscribers is edited in place — there is no history to rewrite, and versioning it would litter the catalogue with dead rows.

**Deleting a plan is not possible and should not be.** `payments.plan_id` and `companies.current_plan_id` are both `RESTRICT`; deleting would orphan real billing records. Disable hides a plan from new buyers. Archived plans stay readable so old payments and mid-subscription companies still resolve.

**Guards implemented:**

| Scenario                          | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disable the only active plan      | `409` — the paywall would have nothing to sell and expired companies would be stranded with no way to pay. Uses a locking count so two admins can't race past it.                                                                                                                                                                                                                                                                                                                                                                        |
| Disabling a plan with subscribers | Allowed. Only stops NEW purchases; access is governed by `subscription_expires_at`, which this never touches.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Re-enable an archived plan        | `400` — it has been superseded; enable the successor instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Edit an archived plan             | `400`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Buy a disabled/archived plan      | Impossible — `PlanRepository.findById` filters on `isActive`, so a stale plan id from an open tab can't be purchased.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Two plans marked "Most Popular"   | Setting one clears the others, **and** a partial unique index enforces it. Application logic alone was insufficient: `clearOtherPopular` runs under READ COMMITTED, so two concurrent creates each can't see the other's uncommitted row and both would commit as popular.                                                                                                                                                                                                                                                               |
| Marking a _hidden_ plan popular   | `400`. It would strip the badge from the plan customers can actually see, leaving the billing page with no featured plan and no visible cause.                                                                                                                                                                                                                                                                                                                                                                                           |
| Currency                          | Single platform currency in `app_settings`, applied on create. **Changing it is refused while any sellable plan still exists in the old currency** — enforcing only at create-time meant existing plans kept the old code and the billing page rendered two currencies side by side, which is exactly what this was supposed to prevent. Auto-converting is worse: 51.31 USD is not 51.31 ZAR, so rewriting the column would silently redenominate real prices. The admin retires the old plans and creates new ones at correct amounts. |
| Unsupported currency code         | `400`. A bare `/^[A-Z]{3}$/` accepted `"XYZ"`, created plans in it, and failed only when a real customer reached PayPal. Now checked against the currencies PayPal settles in.                                                                                                                                                                                                                                                                                                                                                           |
| Currency read staleness           | `getSettings(manager)` bypasses the 60s cache when given a transaction, so a plan created just after a currency change can't be stamped with the previous one inside the very transaction meant to prevent that.                                                                                                                                                                                                                                                                                                                         |
| Archived but still active         | Impossible — DB CHECK `chk_plans_archived_not_active`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Unknown settings key              | Impossible — DB CHECK on `app_settings.key`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Audit:** `admin_audit_log` records plan create/update/version/enable/disable and settings changes, with before/after JSON and a denormalized actor email so the trail survives the user being deleted. Written in the same transaction as the change it describes — an audit trail that can disagree with reality is worse than none. Scoped deliberately to money-affecting actions rather than attempting a general audit system.

**Frontend:** the billing page's "Most Popular" badge was hardcoded to `durationDays === 30`; it now reads `plan.isPopular`, otherwise creating any custom plan would have silently un-featured everything. The `≈ /day` figure was rounding to `0` for anything under ~1.50/day and is now guarded.

**Affected:** `entities/Plan.ts` (+6 cols), new `entities/AppSetting.ts`, `entities/AdminAuditLog.ts`, new `SettingsService`/`PlanService`/`AuditService`, new `AppSettingRepository`, rewritten `PlanRepository`, `SuperAdminController` (+6 handlers), `admin.route.ts`, `admin.schema.ts`, `PaymentService.PlanDto`, `EmailService` (trial length now read from settings), `migrations/1785376800000-addPlanManagement.ts`. Frontend: `/admin/plans`, `PlanFormModal`, `TrialSettingsCard`, `admin.service`, sidebar, billing page.

**Revisit when:** Phase 6 (PayPal Subscriptions) — each plan will additionally need `paypal_plan_id`, and creating a plan will mean creating one at PayPal too. The versioning model above is what makes that safe.

---

### 2026-07-30 · Email verification gates the free-trial clock (closes P1)

**Decision:** Company registration now issues an `email_verification` token and emails a confirmation link. **The 4-day free-trial clock starts on verification, not on registration** — so time spent sitting in an inbox is never charged against the trial.

Resolves pending question **P1** (email verification on company registration): **yes, required.**

**Why:** the trial anti-abuse rule is "one trial per email/phone, ever". That rule is only as strong as the identity behind it. With no verification, disposable-address services make unlimited trials trivial, and — worse — a third party's address can be burned by registering with it, denying _them_ a trial they never used. Verification closes the first hole and is the prerequisite for the identity registry in Phase 3.

**Shape:**

- Reuses the existing `tokens` table with a third `type` discriminator, `email_verification`. `tokens.type` has no CHECK constraint, so no DDL on the column — the only structural change is the partial unique index `uq_tokens_active_email_verification`, mirroring the password-reset one, so mashing "resend" cannot leave a fan of simultaneously-valid links.
- `users.email_verified_at` already existed in the baseline and had never been written. It is now the source of truth.
- TTL is **24h** (`EMAIL_VERIFICATION_TTL_MIN`), far longer than a password reset's 15min: this is the first thing a new customer ever receives, and a short window would strand anyone who checks their inbox later.
- `POST /auth/email-verification/resend` is **authenticated** — registration auto-logs-in, so resend needs no email in the body and therefore cannot be used to probe which addresses exist. `POST /auth/email-verification/confirm` is public, because the link is opened from an inbox in a possibly session-less browser.
- The registration email is enqueued **after the transaction commits**. Inside it, a rollback would still have sent a "welcome, confirm your email" for a registration that never happened, and a Redis outage would fail an otherwise-valid signup. When an outer `EntityManager` is supplied the caller owns the commit, so it also owns sending the mail.
- Verification does **not** grant access on its own. It only establishes that the address is real; Phase 3 starts the trial clock off the back of it.

**Rate limiting:** `POST /auth/register/company` previously had **no limiter at all** beyond the 100-per-15-min global cap. It now sends email and (from Phase 3) dispenses a free trial, making it both a spam vector and a value-dispensing endpoint. Added `registerLimiter` at 5/hour/IP, deliberately **without** `skipSuccessfulRequests` — unlike login, successes are exactly what we are limiting. `emailVerificationResendLimiter` is 3 per 10 minutes.

**Still open (tracked, not solved here):** an unverified _third-party_ address used as `contactEmail` can still be claimed by the Phase 3 identity registry. The mitigation is the admin "release identity" tool, which must ship with Phase 3 rather than after it.

**Affected:** `entities/Token.ts`, `repositories/TokenRepository.ts` (+3 methods), `repositories/UserRepository.markEmailVerified`, `services/AuthService` (`requestEmailVerification`, `confirmEmailVerification`, registration hook), `services/EmailService.enqueueEmailVerification`, `templates/emailVerification.template.ts`, `queues/email.queue.ts`, `workers/email.worker.ts`, `middleware/rateLimit.ts`, `routes/auth.route.ts`, `controllers/AuthController.ts`, `validation/schemas/auth.schema.ts`, `config/index.ts` (`EMAIL_VERIFICATION_TTL_MIN`, `TRIAL_DURATION_DAYS`), `migrations/1785373200000-addEmailVerificationToken.ts`. Frontend: `/verify-email` page, `EmailVerificationBanner`, `auth.service` (+2 methods).

**Revisit when:** if SMS OTP (P2) is ever adopted, phone verification would supersede email as the stronger identity signal — but email verification stays regardless, since the login identity is an email.

---

### 2026-07-30 · Entitlement is a computed function; `subscription_expires_at` stays the gate

**Decision:** Access control is decided by one pure function, `computeEntitlement(company, now)` in `src/utils/entitlement.ts`, called **in real time on every request**. It returns `{ status, hasAccess, isTrial, endsAt, canExport }`.

The new `companies.subscription_status` column is a **materialized projection only** — maintained by the (Phase 4) expiry cron for indexed queries, admin filters and UI badges. **No middleware ever reads it.** That separation is deliberate: a stalled cron, a missed webhook or a clock skew must never revoke access from a customer who has actually paid.

`companies.subscription_expires_at` remains the authoritative end-of-paid-time across all three eras (legacy Orders, trial, future recurring). Recurring subscriptions will never gate access directly — they only push that column forward.

**`subscription_expires_at = NULL` now means exactly one thing: no paid subscription has ever been purchased.** It no longer means "unlimited access". Unlimited access is `is_comped = true`, and nothing else.

**Why:** access was enforced in five places that disagreed. The worst case: `middleware/subscription.ts` treated a null expiry as "admin free override — allow", while the frontend gate (`company/layout.tsx`) treated it as "locked out". An admin-comped company was therefore allowed by the API and bounced to billing by the UI, permanently. Layering a trial on top of that would have multiplied the inconsistency.

**Precedence (strict, and the migration's backfill CASE mirrors it exactly):**
`deactivated` → `comped` → live paid → live trial → lapsed paid → lapsed trial → `pending`.
Paid outranks trial so converting mid-trial can never downgrade the status. `canExport` is true in every state except `deactivated` — that is the "download your data and leave" path.

**Affected:**

- `src/utils/entitlement.ts` — new, pure, DB-free. `src/utils/entitlement.test.ts` covers all 7 branches plus boundary and purity (14 cases, `node:test` via tsx)
- `src/entities/Company.ts` — `+subscription_status` (varchar+CHECK), `+is_comped`, `+comped_until`, `+comp_reason`, `+comp_granted_by_user_id`, `+trial_started_at`, `+trial_ends_at`
- `migrations/1785369600000-addEntitlementAndTrialColumns.ts` — converts the legacy null-override to `is_comped` **before** the status backfill. Omitting that one UPDATE would lock out every admin-comped customer on deploy.
- `middleware/auth.ts` — `companyMiddleware` no longer rejects on `!isActive`; it blocks only `deactivated` and attaches `req.entitlement`. **`billingCompanyMiddleware` deleted** — once `companyMiddleware` stopped enforcing `isActive` the two were identical.
- `middleware/subscription.ts` — null branch deleted; reads `req.entitlement.hasAccess`. New `requireExportAllowed` as a _positive_ assertion so a future blanket `router.use(requireActiveSubscription)` breaks loudly instead of silently killing export.
- `errorHandler.ts` — `SubscriptionRequiredError` → 403 `SUBSCRIPTION_REQUIRED`, distinct from a generic 403 so the FE can show the paywall deterministically. (403 not 402: proxies handle 402 poorly and the FE interceptor already knows 403.)
- `QrService` — both call sites. `resolveByToken` now returns `isAcceptingSubmissions` (entitlement-aware) instead of raw `isActive`; previously it ignored expiry, so the scan page rendered a working form and the customer only hit the wall on submit. Also now returns `country` for the customer-form currency symbol.
- `CompanyService.getProfile` — `+hasAccess`, `+subscriptionStatus`, `+accessUntil`, `+trialEndsAt`, `+isTrial`, `+isComped`, `+canExport`
- Frontend — gate collapses to `if (!profile.hasAccess)`. New `CompanyProfile` type (distinct from `Company`, which the admin endpoints return without entitlement fields).

**Trial columns added here but inert until Phase 3.** Keeping them in this migration means `computeEntitlement` is written and tested once, and `companies` isn't ALTERed twice.

**Login/refresh deliberately unchanged** — they still block only true deactivation. Expired users MUST be able to log in: they need to reach billing to pay, and export to leave.

**Revisit when:** never for the "compute in real time, project for queries" split. The status value set may gain members (`past_due` is already in the CHECK, unused until recurring billing ships).

---

### 2026-06-07 · Password policy — 8–18 chars + special char required; HIBP breach check removed

**Decision:** The password policy for any password being SET (company registration, password-reset confirm, in-app password change) is now: **8–18 characters, with at least one lowercase letter, one uppercase letter, one number, and one special character** (any non-alphanumeric). The previous policy was 8–128 chars with lower/upper/digit and no special-character requirement.

At the same time, the HaveIBeenPwned (HIBP) k-anonymity breach check is **fully removed** — see the superseded 2026-04-17 HIBP entry below. `PasswordService.isCompromised()` is deleted, the create-superadmin `--skip-hibp` flag is gone, and the `400 BAD_REQUEST "This password has appeared in a known data breach."` error (and its fail-open-on-outage behavior) no longer exists anywhere.

**Scope:** Applies only to passwords being SET. Login and current-password fields are unchanged (no policy enforced on the value being checked against the stored hash).

**Why:** A deterministic complexity rule (special char required, tighter max length) is enforced locally with no external dependency, removing the HIBP network call and its fail-open hole from the registration / reset / change hot paths.

**Affected:**

- `PasswordService` — `isCompromised()` removed
- `common.schema.ts` — `password` field rule updated (8–18, special char required), friendly message updated
- `registerCompanySchema`, password-reset-confirm schema, password-change schema — pick up the new shared rule
- `AuthService.registerCompany` / reset-confirm / `changePassword` — HIBP call removed
- create-superadmin script — `--skip-hibp` flag removed
- `flows.md`, `endpoints.md` — HIBP steps removed, password-rule text updated

**Revisit when:** If credential-stuffing with leaked passwords becomes a real problem, reintroduce a breach check (e.g., a bundled local Bloom filter of HIBP data) rather than a live API call.

---

### 2026-06-07 · Registration bundles plan purchase (auto-login + pay in one flow)

**Decision:** `POST /api/auth/register/company` now **issues a session (auto-login)** — the response includes `tokens`, `companyId`, and `companyIsActive` (false) alongside `user` and `company`, and the message is "Registration successful." The register form **requires selecting a plan**. Immediately after a successful register, the frontend creates a PayPal order for the chosen plan (`POST /api/payments/paypal/create-order`) and redirects to PayPal; on return, `/company/billing/success` captures and activates the company. There is no separate login step and no "await activation" screen.

**Supersedes:** the earlier "no tokens at registration / super-admin manual activation" decision and the login "pending → 403 awaiting activation" copy (both below). Pending companies are no longer blocked — they are issued tokens (at registration and at login) so they can self-serve pay.

**Why:** collapses register → login → billing into one continuous flow, reducing drop-off. The company is still created pending (`isActive=false`) and only activates on payment capture, so the pay-gate is intact. If the user abandons PayPal or order creation fails, the company stays pending and the user remains logged in — they can finish paying later from `/company/billing` (fallback preserved).

**Affected:**

- `AuthService.registerCompany` — issues tokens within the registration transaction; result now carries `tokens`/`companyId`/`companyIsActive`
- `AuthController.registerCompany` — message → "Registration successful."
- Frontend `register/page.tsx` — required plan picker; submit chains register → create-order → PayPal redirect; old pending screen removed; `authSlice`/`auth.service` persist the session like login
- Verified live (2026-06-07): register → create-order against PayPal **sandbox** returns an approval URL; company lands pending with a pending USD payment row

**Revisit when:** if switching to PayPal **Subscriptions** (recurring auto-billing) — that would replace the one-time create-order step and add a `subscriptions` table.

---

### 2026-05-03 · QR submit cooldown — 15-minute resubmit gate per `(company, mobile)`

**Decision:** A customer cannot record a second purchase at the same company within `QR_MIN_RESUBMIT_INTERVAL_MIN` (default 15) minutes of their last successful submission. Enforced at the service layer in `QrService.assertResubmitCooldown` using `customers.last_submission_at` (the denormalized field already maintained atomically by the existing aggregate update).

**Why service-layer (not Redis middleware):** the existing per-minute / per-day Redis limiters count _attempts_ — they'd block a customer who fat-fingered an invoice number. The cooldown should only apply after a _successful_ submission, which is what `customers.last_submission_at` records.

**Why mobile-only (not mobile + vehicle):** for fuel stations, the same mobile can map to multiple customer rows (one per vehicle). The cooldown is per-phone, regardless of vehicle. `CustomerRepository.findMostRecentByCompanyAndMobile` returns the customer row with the latest `last_submission_at` matching `(company, mobile)`, vehicle-agnostic.

**Order of checks in `QrService.submitPurchase`:**

1. company exists + active
2. business-type field check (Joi-stage shape was validated earlier)
3. **cooldown check** (new — uses `last_submission_at`)
4. invoice-number duplicate check
5. customer find/create + purchase create + aggregate update

**Response:** `429 RATE_LIMIT_EXCEEDED` with friendly message including remaining minutes (rounded up, min 1). New `TooManyRequestsError` factory added to error helpers (`errorHandler.ts` + `errors/index.ts`).

**Tunable:** set `QR_MIN_RESUBMIT_INTERVAL_MIN=0` in env to disable. Customers with no prior submission are never blocked (first-time customers always pass).

**Race note:** two concurrent submissions could both pass the check before either updates `last_submission_at`. Acceptable — this is a spam-deterrent, not a correctness invariant. Hard correctness still lives in the existing `UNIQUE(company_id, invoice_number)` constraint.

**Revisit when:** if real-world abuse suggests tightening or loosening the window, or if we need a per-business-type override.

---

### 2026-05-03 · P0 audit fixes — sanitization, Redis-backed limiters, hardened helmet, email worker, token cleanup

**Decision (5 changes shipped together based on audit findings):**

1. **23505 sanitization** — `errorHandler.ts` no longer echoes Postgres `pgError.detail` (which leaked column names + offending values). A new `mapUniqueViolationToFriendly()` parses the column name from `Key (col)=(value)` format and maps to a per-field user-friendly message via `COLUMN_TO_FRIENDLY` table. Composite keys iterate columns and surface the most user-relevant one (e.g., `(company_id, invoice_number)` returns the invoice-number message). Closes user-enumeration vector.

2. **Rate limiters consolidated to Redis** — `middleware/rateLimit.ts` now exports a `buildLimiter(opts)` factory plus 5 named limiters (`globalApiLimiter`, `loginLimiter`, `passwordResetRequestLimiter`, `qrSubmitPerMinuteLimiter`, `qrSubmitPerDayLimiter`). All use `rate-limit-redis`. `app.ts` and `auth.route.ts` import the named limiters. Survives restart, atomic across instances.

3. **Helmet hardened** — `app.ts` passes `{ contentSecurityPolicy: false (API doesn't serve HTML), crossOriginResourcePolicy: { policy: "cross-origin" } (cross-origin resource access from the FE origin), hsts: { maxAge 1y, includeSubDomains, preload } }`.

4. **Pino redaction expanded** — `utils/logger.ts` now also covers `req.body.password`, `req.body.refreshToken`, `req.body.token`, `*.currentPassword`, `*.newPassword`, `*.confirmNewPassword`, `*.resetToken`, `req.headers['x-api-key']`. Closes secret leakage in request logs.

5. **Email worker live** — `nodemailer` + BullMQ-backed worker. `src/queues/email.queue.ts` (queue), `src/workers/email.worker.ts` (worker), `src/services/EmailService.ts` (high-level enqueuer), `src/templates/passwordReset.template.ts` (HTML + text), `src/config/mailer.ts` (transporter singleton). `AuthService.requestPasswordReset` enqueues a `passwordReset` job with `{ to, resetUrl, expiresInMinutes }`. Worker started + gracefully closed in `server.ts`. Reset URL: `${FRONTEND_BASE_URL}/reset-password?token=<raw>`. Template self-contained (inline CSS for email-client compat). Job retries: 5 with exponential backoff. Failed jobs retained 7 days for visibility. Email-queue failure does NOT block the API response — error is logged and swallowed (the user can re-request).

**Why bundled:** these were the audit's P0 blockers. Shipping piecemeal would've left half the security surface still leaky.

**Env variables added:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`. Old `SENDGRID_*` env vars removed (replaced by SMTP).

---

### 2026-05-03 · Token cleanup cron — append+revoke storage needs periodic GC

**Decision:** A daily cron at 03:00 UTC deletes `tokens` rows where `(revoked_at IS NOT NULL OR consumed_at IS NOT NULL OR expires_at < NOW()) AND created_at < NOW() - INTERVAL '30 days'`. Preserves a 30-day audit window for tombstoned tokens, then prunes.

**Why:** `tokens` uses append + revoke (every login → 1 row, every refresh → another, old ones get `revoked_at = now()`). Required for theft detection (we need the historical record to detect "this revoked token is being reused"). But without cleanup the table grows unbounded with login + refresh + reset frequency. 30-day retention is enough to investigate any reuse incident.

**Implementation:** `src/cron/tokenCleanup.cron.ts` using `node-cron` (already installed). Started in `server.ts`, gracefully stopped on shutdown. Logs `{ deleted, cutoff }` on each run.

**Revisit when:** if any single instance shows table growth over ~10M rows despite cleanup, switch to time-partitioning on `created_at`.

---

### 2026-05-03 · Structured address fields — split single `address` into 5 columns

**Decision:** Replace `companies.address` (single text column) with 5 structured columns: `street_address`, `city`, `state`, `country` (all NOT NULL) and `postal_code` (nullable). Joi schemas + DTOs use camelCase (`streetAddress`, `postalCode`). The single-column shape is fully removed — Joi `strict()` will reject the legacy `address` key as unknown.

**Why:** FE plans to render separate inputs and use a country-state library (e.g. `country-state-city`) to populate Country and State dropdowns. Free-text addresses can't drive that UI cleanly. Splitting is also better for filtering, reporting, and future shipping/tax logic. Postal code is nullable because Niger and several West African markets don't use them — making it required would block legitimate registrations.

**Migration approach:** Pre-launch dataset is small. The migration adds the 5 columns nullable, runs a lossy auto-fill on existing rows (`street_address = old address`, `city/state = "—"`, `country = "Niger"`, `postal_code = NULL`), then sets NOT NULL on the 4 mandatory columns and drops the old `address` column. Companies can clean up via `PUT /api/company/profile` post-migration. Manual cleanup acceptable per user preference but the migration runs cleanly without it.

**Affected (all updated in same change):**

- `src/entities/Company.ts` — entity columns
- `migrations/1777200000000-splitCompanyAddress.ts` — up/down with backfill
- `src/validation/schemas/common.schema.ts` — `addressFields` reusable Joi field-builders with friendly messages
- `src/validation/schemas/auth.schema.ts` — `registerCompanySchema` + `RegisterCompanyInput` type
- `src/validation/schemas/company.schema.ts` — `updateProfileSchema` + `UpdateProfileInput` type (each address field individually editable, partial-update semantics intact)
- `src/services/AuthService.ts` — `RegisterCompanyResult` + `registerCompany` body
- `src/services/CompanyService.ts` — `CompanyProfile` interface + `getProfile` + `updateProfile`
- `src/repositories/CompanyRepository.ts` — `updateProfile` signature
- Admin endpoints (`GET /api/admin/companies`, `:companyId`) return raw `Company` entity, so the new shape flows through automatically

**Revisit when:** never — address shape is now structured, future improvements (geocoding, distance queries) are additive.

---

### 2026-05-03 · Pagination contract: in-app list endpoints paginate; bulk-export endpoints do not

**Decision:** Every endpoint that returns a list of records for in-app browsing (admin companies list, company customers list, company purchases list, future admin/customer-side lists) MUST be paginated with `page` + `limit` query params and return `{ items, pagination }`. Endpoints whose entire purpose is **bulk export** (CSV/PDF reports) intentionally return ALL records — pagination would defeat the purpose.

**Why:** User flagged this as a recurring concern — every table in the FE should hit a paginated endpoint, never an unbounded list. Bulk exports are a different category and stay unbounded by design.

**Current paginated:** `GET /api/admin/companies`, `GET /api/company/customers`, `GET /api/company/purchases`.
**Current unpaginated by design:** none live (the former CSV export endpoints `GET /api/company/customers/export` and `GET /api/company/purchases/export` were removed). Future PDF report endpoints (top-10, all-customers) follow this exemption.

**Defaults:** `page=1`, `limit=10`, `max limit=100` (enforced via `paginationSchema`).

**How to apply on every new endpoint:**

1. If it returns a list for in-app rendering → use `paginationSchema` + `BaseController.paginationResponse()` + repo method that returns `{ items, total }`.
2. If it returns a bulk export (CSV/PDF) → no pagination. Document the exemption in `endpoints.md`.
3. If it returns a fixed-cap report (e.g., top-10 customers) → no pagination needed; document the cap.

**Revisit when:** never — this is a baseline quality bar.

---

### 2026-05-03 · Top-N customer report: dense-rank by amount, sequential row numbers, FCFS tiebreak

**Decision:** "Top 10 customers" report uses **dense ranking** by `total_invoice_amount` (not raw `LIMIT 10`) — if multiple customers tie for a rank, all are returned. So a "top 10" can return 13+ rows when ties exist (e.g., 3 customers tied for rank 4 + 2 tied for rank 10 = 13 rows for ranks 1–10).

**Display rule:** the PDF/UI shows **sequential row numbers** (1, 2, 3, …, 13), not shared ranks. Among tied customers, ordering is **first-come-first-serve** — the customer who crossed that amount earliest gets the lower row number.

**SQL approach:**

```sql
SELECT *
FROM (
  SELECT *,
         DENSE_RANK() OVER (ORDER BY total_invoice_amount DESC) AS rnk
  FROM customers
  WHERE company_id = $1 AND deleted_at IS NULL
) t
WHERE rnk <= 10
ORDER BY total_invoice_amount DESC, last_submission_at ASC, id ASC;
```

**Ordering rationale:**

- `total_invoice_amount DESC` — primary sort, the leaderboard amount
- `last_submission_at ASC` — within a tied amount, whoever reached it earliest gets the lower row number (FCFS)
- `id ASC` — deterministic final tiebreak

**Why dense-rank, not LIMIT 10:** plain `LIMIT 10` silently drops tied customers based on a non-deterministic secondary order. Dense-rank guarantees fairness — every customer who placed in the top-10 amount tiers shows up.

**Index utilization:** existing `idx_customers_company_total` on `(company_id, total_invoice_amount)` makes the window function fast (single-company partition scan).

**Status:** decision locked; endpoint not yet implemented (pending PDF generation).

**Revisit when:** never — this is the canonical "top N" interpretation for leaderboards.

---

### 2026-05-03 · Login: state-specific copy AFTER password verification, uniform copy before

**Decision:** Login keeps uniform `401 "Invalid credentials"` for user-not-found / user-inactive / wrong-password (anti-enumeration). But once the password is verified, the company state checks reveal a specific message:

- ~~Pending activation → `403 "Your account is awaiting activation…"`~~ **(superseded 2026-06-07 — pending companies now log in; tokens are issued with `companyIsActive: false` so they can self-serve pay)**
- Admin-deactivated → `403 "Your account has been deactivated. Please contact support."`

**Why:** Previously, both pending and deactivated companies hit a generic message after password verification — confusing for legitimate users (especially newly-registered ones who couldn't tell why login failed). Revealing state AFTER password verification is safe: the caller has proven account ownership, so the leak window is closed. Password-spraying attackers hit the uniform `Invalid credentials` 99.9%+ of the time and never reach the state branch.

**Distinguishing pending vs deactivated:** uses `companies.deactivatedAt IS NULL` (the same derived state used by the admin three-state badge).

**Affected:**

- `AuthService.login` — branched the company-state check; added `ForbiddenError` import
- `flows.md`, `endpoints.md` — login flow + error cases updated
- FRONTEND_API_GUIDE.md, FRONTEND_FLOWS.md — Login error cases updated

**Revisit when:** never — this is the right balance of security and UX.

---

### 2026-05-03 · All user-facing error messages must be product copy, not lib defaults

**Decision:** Every Joi validation, ConflictError, BadRequestError, or rate-limit message that can reach a user is written as a complete, polished sentence — no field names borrowed verbatim, no `must be at least N characters`, no `is required`. Override Joi defaults via `.message()` / `.messages({})` on every user-facing field. Polish the shared `commonPatterns` in `common.schema.ts` so the fix propagates everywhere.

**Why:** User flagged two cases: QR resolve returned `"qrToken" length must be at least 16 characters long` (technical leak on a customer-facing public endpoint), and registration conflict returned `"One or more identifiers already exist"` (awkward parent message). Both look unprofessional in a B2B fintech-style product. For public/customer-facing flows specifically, prefer a single generic message ("QR code is invalid") over leaking which rule failed — saves an enumeration signal too.

**Where applied (2026-05-03):**

- `qr.schema.ts` — `qrTokenParamSchema` collapses 4 rules into one user-facing message
- `auth.schema.ts` — `confirmPassword`, `confirmNewPassword` (both reset + change), `termsAccepted` polished
- `common.schema.ts` — `username`, `password`, `phoneE164` polished (propagates everywhere)
- `AuthService.assertUniqueIdentifiers` — parent message + each `details[].message` rewritten

**How to apply on every new endpoint:**

1. Define the schema with explicit `.messages({})` for each rule that has a user-facing trigger.
2. Service-layer thrown errors: write the message as if it'll appear in a toast.
3. Don't include field names in the message text — the `details[].field` is already there for the FE to wire to the input.

**Revisit when:** never — this is a baseline quality bar.

---

> **SUPERSEDED (2026-06-07)** by "Registration bundles plan purchase (auto-login + pay)" above — registration now issues tokens and bundles payment, and pending companies can log in to self-serve pay. Historical text follows.

**Decision:** New companies are created with `is_active=false` and **no tokens are issued** at registration. The user receives a "pending activation" message and cannot log in until a super admin activates them (typically after manual payment verification). The activate/deactivate endpoints already exist; "first activation" reuses the same path as "reactivate."

**Why:** Until the payment gateway is integrated, payment verification is manual. The previous auto-activation flow let companies use the platform without paying. This change closes that loop with a one-line schema flip (the same hook flagged in `schema.md`'s adaptability anchors), and surfaces three states the admin UI can render: pending / active / deactivated (distinguishable via `is_active` + `deactivated_at`).

**Affected:**

- `AuthService.registerCompany` — `is_active=false`, no token issuance, no `tokens` in result
- `AuthController.registerCompany` — message updated to explain pending activation
- Login already uses uniform `Invalid credentials` for `!company.isActive`, so pending companies can't log in (no extra change needed)
- Admin list endpoint already returns `isActive` + `deactivatedAt` so FE can derive the three states client-side

**Alternatives:**

- Add a separate `pending` status column or PG enum — rejected, deactivation audit fields already differentiate the three states without schema change
- Block at the controller-level `companyMiddleware` only — rejected, login itself must reject pending companies for security clarity (it already does)

**Revisit when:** Payment gateway integration ships — webhook becomes the activation trigger instead of manual admin action.

---

### 2026-04-13 · Single `users` table + `companies` 1:1 profile (Model A)

**Decision:** One `users` table holds auth for all roles. `companies` is a 1:1 profile linked via `owner_user_id`. `users.user_type` column (varchar + CHECK) distinguishes super_admin vs company.

**Why:** Unified auth pipeline — one login endpoint, one password-reset flow, one JWT issuance path. Tokens table gets a single `user_id` FK (not polymorphic). Future roles (staff/operators) are additive: new `user_type` + new profile table, no auth rewrite.

**Alternatives:** Separate `super_admins` and `companies` auth tables. Rejected — duplicated auth logic, polymorphic tokens, harder future extension.

**Revisit when:** Never, unless we split tenancy.

---

### 2026-04-13 · Dropped `user_types` lookup table

**Decision:** `users.user_type` is a `varchar(32)` column with CHECK constraint, backed by a TS string-literal union (`as const` array). No separate lookup table.

**Why:** With only 2 fixed values (`super_admin`, `company`) fully controlled in code, a lookup table adds a join + a seed migration for no benefit. CHECK constraint + TS type gives us both DB- and compile-time safety.

**Alternatives:** Separate `user_types` table with FK, or Postgres native ENUM. Both rejected — lookup is overkill at this scale, PG enums are migration-painful.

**Revisit when:** If we ever need per-type metadata (labels, permission bitmaps, etc.).

---

### 2026-04-13 · Customers + Purchases as separate tables, Option B for name/vehicle

**Decision:** Two tables. `customers` holds canonical identity + cached aggregates (`total_invoice_amount`, `submission_count`). `purchases` holds individual submissions with immutable `full_name_snapshot` and `vehicle_number_snapshot`. On every submission, the customer row's `full_name` and `vehicle_number` are **overwritten with latest values (Option B)**.

**Why:** The top-spender PDF is the product's main output — it's a list of customers, not purchases. Keeping `customers` as a first-class entity with cached aggregates makes dashboard and report queries trivial and instant. Purchase snapshots preserve historical truth even if the customer row is overwritten with a typo.

**Alternatives:**

- Single `purchases` table, aggregate on the fly — rejected, couples identity to query-time aggregation, messy name resolution.
- Option A (first name wins) — rejected by user in favor of latest-wins.
- Option C (majority frequency) — rejected as overkill.

**Revisit when:** If aggregate-update cost becomes measurable at scale (unlikely for sena-temp traffic profile).

---

### 2026-04-13 · `Customer.company` onDelete = RESTRICT (was CASCADE)

**Decision:** Deleting a company fails if any customers exist. Same for `purchases` (already RESTRICT).

**Why:** Fintech audit safety. No accidental `DELETE FROM companies` should wipe transactional history. Use soft-delete for everything financial.

**Alternatives:** CASCADE — rejected on audit-safety grounds.

**Revisit when:** Never.

---

### 2026-04-13 · Tokens and password resets in one table

**Decision:** Single `tokens` table with `type` discriminator (`refresh` | `password_reset`). Partial unique index `UNIQUE(user_id) WHERE type='password_reset' AND consumed_at IS NULL` enforces at most one active reset per user.

**Why:** 80% shared fields (user_id, token_hash, expires_at). Repository exposes type-specific methods only (`findActiveRefreshToken`, `findUsablePasswordResetToken`) — no generic `findByHash` to leak type filters. Partial index closes the rapid-fire "forgot password" race condition.

**Alternatives:** Separate `refresh_tokens` and `password_resets` tables. Rejected on simplicity grounds after weighing the "forgot the type filter" risk (mitigated by repo discipline).

**Revisit when:** If we add a third token variant with materially different semantics.

---

### 2026-04-13 · Token storage: hash-based, not JTI

**Decision:** Refresh tokens are opaque random bytes (48-byte base64url); we store the SHA-256 hash. No JTI/JWT for refresh — only the short-lived access token is a JWT.

**Why:** Uniform pattern for both token types (refresh + password_reset both use opaque+hash). Refresh tokens being opaque is a security feature — clients shouldn't inspect or trust refresh claims. Matches Auth0 / AWS Cognito modern pattern.

**Alternatives:** JWT refresh tokens with JTI claim stored in DB. Rejected — mixes JWT-for-refresh with opaque-for-reset, adds asymmetry with no security gain.

**Revisit when:** Never, unless a client SDK demands JWT refresh tokens.

---

### 2026-04-13 · Enums: varchar + CHECK, not Postgres ENUM

**Decision:** All enum-like columns (`user_type`, `business_type`, `type` on tokens) are `varchar(32)` + CHECK constraint. TypeScript side uses `as const` arrays + derived string-literal unions.

**Why:** Changing CHECK = drop + re-add, one migration. Postgres native ENUM is painful — `ALTER TYPE ADD VALUE` can't run in a transaction in older PG; renaming/removing values is table-rewrite surgery. TypeORM enum-alter support is historically shaky.

**Alternatives:** PG native ENUM, TS `enum` keyword. Rejected on migration pain + modern TS style.

**Revisit when:** Never.

---

### 2026-04-13 · Plans / subscriptions / payments deferred

**Decision:** No `plans`, `subscriptions`, `payments` tables in v1. Companies auto-activate on registration (`is_active = true`, `joined_at = now()`).

**Why:** Client hasn't finalized plan structure (fixed 15/30 vs custom) or payment gateway. Schema stays additive — new tables when decisions land, no breaking changes to existing ones.

**Adaptability hooks:** `CompanyService.getActivationStatus()` to become subscription-aware later. Registration flow default for `is_active` flips from `true` → `false` when payment webhook gates activation.

**Revisit when:** Client confirms plan + gateway.

---

### 2026-04-13 · No centralized audit_logs, email_logs, bulk_email_campaigns, report_jobs tables

**Decision:** Cover audit needs via scattered who/when fields on affected tables (`users.password_changed_at`, `users.last_login_at`, `companies.joined_at`, `companies.deactivated_at/by`). Rely on SMTP provider logs + BullMQ job retention for email visibility. PDF reports planned as on-demand endpoints.

**Why:** MVP scope. Adding these tables is additive — defer until needed. Compensating fields cover the "who did what, when" trail for v1's sensitive actions.

**Revisit when:** Compliance requirement, or support needs "why didn't X email arrive" beyond what the SMTP provider + BullMQ retention surface.

---

### 2026-04-14 · `activated_at/by` dropped; renamed to `joined_at`

**Decision:** Company table has `joined_at` (NOT NULL, set at registration) instead of `activated_at` + `activated_by_user_id`. Deactivation audit (`deactivated_at`, `deactivated_by`) preserved.

**Why:** Activation is automatic on registration in v1 — no "who activated" to track. `joined_at` is the semantically correct field. When payments ship and activation becomes gated, we'll add activation fields back (additive).

**Revisit when:** Payment-gated activation is introduced.

---

### 2026-04-14 · Column `name:` in @Column only when camelCase differs from snake_case

**Decision:** `@Column({ name: "user_type" }) userType!: UserType` — yes. `@Column() email!: string` — no `name:`.

**Why:** User preference — no redundant decorator options.

---

### 2026-04-14 · Customer `first_submission_at` / `last_submission_at` NOT NULL

**Decision:** Both fields are NOT NULL. Customer row is always created inside the same transaction as the first purchase submission, so these are always set.

**Why:** Enforces the invariant "customer row exists ⟺ at least one purchase submitted." Stronger than nullable + service discipline.

**Revisit when:** Never, unless we add a flow that pre-creates customer records (e.g., admin-seeded customers).

---

### 2026-04-14 · No `readonly` on class members

**Decision:** Class fields in services/repositories/controllers are `private foo = new Bar()`, not `private readonly foo = new Bar()`. The `typescript:S2933` lint warning is intentionally ignored.

**Why:** User preference — simpler declaration syntax.

---

### 2026-04-14 · QR strategy — deferred

**Decision:** QR code generation and validation flow not yet designed. Entities and flows kept QR-agnostic.

**Why:** Multiple viable options (permanent company QR vs per-transaction operator-generated QR vs hybrid with SMS OTP). User will decide later. Whichever is chosen, the schema change is additive — either 1 field on `companies` or a new `qr_tokens` table.

**Revisit when:** User is ready to pick between Option A / B / C (see earlier discussion).

---

### 2026-04-15 · QR strategy — **LOCKED** (supersedes the deferral above)

**Decision:** Static, crypto-random, unguessable QR token, generated once at company registration, stored on `companies.qr_token` (unique). Printed on signage at the counter/wall. Never rotates.

**Why:** Simplest for fuel stations/shops — printable sticker, no operator required, customer-friendly. Random token prevents ID-enumeration attacks; uniqueness is a DB constraint.

**Related anti-spam decisions:**

- Identity-based rate limiting (`company_id, mobile`) as the core spam defense
- `UNIQUE(company_id, invoice_number)` at DB level blocks duplicate receipt submissions
- Device fingerprinting: **rejected** (unreliable on mobile web, false-positives legitimate customers, easily bypassed)
- 5-hour device lockout: **rejected** (penalizes loyal repeat customers)
- Showing previous submission on repeat scan: **rejected** (PII leak when device tracking is wrong)

**Revisit when:** If real-world fraud shows up, layer in SMS OTP as phase 2 (see Pending).

---

### 2026-04-15 · IP + user-agent stored, not used in rate limiting

**Decision:** Capture `ip_address` and `user_agent` on every purchase for forensics/audit. No IP-based rate limiting.

**Why:** IP has serious false-positive risk in Niger context — NAT/shared WiFi/mobile-carrier NAT groups many legitimate customers under one IP. Can silently block a legitimate 31st customer at a fuel station. Storing for audit = high value; enforcing = high risk of wrong calls.

---

### 2026-04-15 · Geolocation capture via browser API

**Decision:** Capture `latitude`, `longitude`, `location_accuracy` on each purchase submission — all nullable. Browser's free `navigator.geolocation` API (W3C standard). Explicit user consent via browser prompt.

**Why:** Free, standard, forensic value. Nullable because many users will decline the permission prompt.

**Not doing:** IP-based geolocation (noisy in Niger, adds cost + latency).

---

### 2026-04-15 · Rate limit storage — Redis

**Decision:** Use Redis (via the BullMQ connection) for identity-based rate limiting.

**Why:** Single-instance deployment for MVP, but user plans possible horizontal scaling. Redis-backed limits survive restart, are atomic across instances, auto-expire via TTL. Redis is already in the stack for queues.

**Defaults (env-tunable):**

- `QR_SUBMIT_RATE_PER_MINUTE` = 10 (per company_id + mobile)
- `QR_SUBMIT_RATE_PER_DAY` = 50 (per company_id + mobile)
- `AUTH_LOGIN_RATE_PER_IP_PER_MINUTE` = 5 (stricter rate limit on /login)

---

### 2026-04-15 · Customer identity — partial unique indexes per business type

**Decision:** Replace single `UNIQUE(company_id, mobile)` with two partial unique indexes:

- Shop (`vehicle_number IS NULL`): UNIQUE(`company_id`, `mobile`)
- Fuel (`vehicle_number IS NOT NULL`): UNIQUE(`company_id`, `mobile`, `vehicle_number`)

**Why:** User rule — fuel station identity = (mobile + vehicle). Same mobile with two different vehicles = two customer records. Shops keep single-mobile identity. Partial indexes let both coexist cleanly.

**Enforced at all layers:** Joi schema (per business type), service layer (reject vehicle on shop / require vehicle on fuel), DB partial unique indexes.

---

### 2026-04-15 · Refresh token rotation on every use

**Decision:** Every `/auth/refresh` call issues a NEW refresh token and marks the old one revoked. If a refresh token is presented AFTER being revoked, that's suspected token theft → revoke all refresh tokens for that user + require re-login.

**Why:** Shrinks the window of a stolen refresh token from 7 days to minutes. Standard OAuth 2.0 best practice for confidential clients.

---

### 2026-04-15 · Observability foundation — pino + Sentry + request correlation IDs

**Decision:** Replace `console.log`-based logger with `pino` (structured JSON logs). Add request-correlation-ID middleware. Integrate Sentry for error tracking. Plan BetterStack / UptimeRobot for uptime.

**Why:** Single biggest production gap. Without it, outages go undetected and debugging is guesswork.

---

### 2026-04-15 · `/ready` readiness probe

**Decision:** Add a `/ready` endpoint that pings DB + Redis and returns 200 only if both are reachable. `/health` stays as a shallow liveness probe.

---

### 2026-04-15 · Per-IP rate limit on `/auth/login`

**Decision:** Stricter rate limiter on `/auth/login` (5 per IP per minute, env-tunable), independent of the global API limit.

**Why:** bcrypt cost of 12 makes login CPU-expensive (~200ms). Without per-IP cap, a credential-stuffing attacker can DOS the login endpoint.

---

### 2026-04-15 · Purchase fields added for forensics

**Decision:** Add to `purchases` table: `ip_address` varchar(64) nullable, `user_agent` varchar(512) nullable, `latitude` numeric(9,6) nullable, `longitude` numeric(9,6) nullable, `location_accuracy` numeric(10,2) nullable.

**Why:** Support fraud investigation without active enforcement. All nullable because many users will decline geolocation consent.

---

### 2026-04-15 · Invoice amount cap

**Decision:** Server-side max for `invoice_amount` — hard cap env-configurable (default `MAX_INVOICE_AMOUNT = 10000000` = 10M in whatever currency). Rejects submissions above it.

**Why:** Without a cap, anyone could inflate top-spender ranking by claiming an invoice of 999,999,999.99.

---

### 2026-04-15 · PDF report generation → BullMQ queue

**Decision:** Report generation is async. API enqueues a job + returns immediately with `jobId`. Worker generates PDF → uploads → emails a link. Frontend polls status or receives email.

**Why:** Large reports can take 30+ seconds. Running synchronously blocks the web worker, risks HTTP timeout, and doesn't scale.

**Note:** When Phase 4 (dashboards) begins, re-introduce a light `report_jobs` table (previously deferred) for status tracking. Small additive migration.

---

### 2026-04-15 · Async email via BullMQ

**Decision:** All outgoing emails (sent via SMTP/nodemailer) go through a BullMQ email queue with retry + exponential backoff. No synchronous send calls in request handlers. (Email provider was later switched from SendGrid to SMTP/nodemailer; the async-queue principle is unchanged.)

**Why:** Mail-server outages/slowness shouldn't block API responses. Retries handle transient failures. Dead-letter monitoring flags permanently failed emails for manual review.

---

### 2026-04-15 · ESLint + Prettier enforced

**Decision:** Configure ESLint (strict TypeScript rules) + Prettier + pre-commit hooks (`husky` + `lint-staged`). Enforce before any PR merge.

**Why:** Catch quality issues at commit time, not review time.

---

### 2026-04-17 · Pino logger + request correlation IDs

**Decision:** Replaced custom console-based Logger with `pino` (structured JSON in prod, `pino-pretty` in dev). `pino-http` automatically logs every request with a `req.id` that's generated (crypto.randomUUID) or accepted from incoming `X-Request-Id`. Response header always carries `X-Request-Id`. All error responses include `requestId` in the body. `pino.redact` scrubs password/token/auth-header fields.

**Why:** Production observability foundation. Without structured logs + correlation, debugging incidents is guesswork.

**Not doing yet:** AsyncLocalStorage for service-level correlation (add when needed). Sentry integration (scheduled for next hardening pass).

---

### 2026-04-17 · HIBP k-anonymity password check

> **SUPERSEDED / REMOVED (2026-06-07):** The HIBP breach check has been fully removed from the codebase. `PasswordService.isCompromised()` was deleted, the `--skip-hibp` flag on the create-superadmin script is gone, and the `400 BAD_REQUEST "This password has appeared in a known data breach."` error no longer exists on registration, password-reset-confirm, or password-change. In its place, the password policy was strengthened to require a special character (see the 2026-06-07 password-policy decision below). Original entry preserved for history.

**Decision:** On registration and on password reset confirm, the submitted password's SHA-1 prefix (first 5 chars) is sent to `api.pwnedpasswords.com/range/<prefix>`. If any suffix match → reject with 400. Fail-open on network error (log warning, don't block).

**Why:** Free, privacy-preserving (no full password leaves server), defends against credential stuffing with leaked passwords. Fail-open because HIBP outages shouldn't block user flows.

**Revisit when:** If outages become chronic, consider bundling a local Bloom filter of HIBP data.

---

### 2026-04-17 · Refresh token rotation with theft detection (implemented)

**Decision:** Every `/auth/refresh` call revokes the presented refresh token and issues a new pair. If a presented refresh token is ALREADY revoked → revoke all of that user's refresh tokens + log `warn` + 401 "Session invalidated."

**Why:** Shrinks stolen-token blast radius from 7 days to one refresh cycle. Reuse of an old token is a reliable theft signal — nuking all sessions is the correct response.

---

### 2026-04-17 · Password reset post-success revokes ALL refresh tokens

**Decision:** After `/auth/password-reset/confirm` succeeds, every refresh token for that user is revoked. User must log in again on every device.

**Why:** Classic post-password-change hygiene. If the password was reset because of suspected compromise, the attacker may hold active refresh tokens — invalidate them all.

---

### 2026-04-17 · Auth middleware loads user on every authenticated request

**Decision:** `authMiddleware` verifies JWT signature + expiry, then loads the user row (checks `is_active`, not soft-deleted). Adds ~2-5ms per authenticated request.

**Why:** Mid-session deactivation (e.g., super admin disables a company) must fail the next request. JWT alone can't express this. Standard tradeoff for B2B systems where account revocation latency matters.

**Revisit when:** If this becomes a bottleneck at scale, cache user by id in Redis with short TTL (60-120s).

---

### 2026-04-17 · Token entity — no explicit userId column; repository loads user relation

**Decision:** `Token.user` is the only reference to the parent user (no separate `userId` property). Token queries that need the user ID use `leftJoinAndSelect("t.user", "u")` in QueryBuilder so `tokenRow.user.id` is accessible.

**Why:** User preference (dropped redundant FK columns earlier). The JOIN cost is trivial for token lookups (handful per minute per user).

---

### 2026-04-17 · Login per-IP rate limit 5/min, in-memory store

**Decision:** `/auth/login` rate-limited at 5 requests per IP per minute via `express-rate-limit` in-memory store. `skipSuccessfulRequests: true` so only failed attempts consume the budget. Stricter than the global API limit.

**Why:** Credential stuffing defense. In-memory is fine for single instance; resets on restart (acceptable). Migrate to Redis store when we scale horizontally.

---

### 2026-04-17 · Password reset request rate limit 3/min per IP

**Decision:** `/auth/password-reset/request` rate-limited at 3/min per IP.

**Why:** Prevents enumeration via timing AND SMS/email spam-bomb abuse (even though we return 200 uniformly, heavy traffic to the endpoint is abusable).

---

### 2026-04-17 · Company dashboard endpoints auto-scoped by `req.company.id`

**Decision:** The `companyMiddleware` loads the company once and stashes it on `req.company`. All company-dashboard endpoints take the company ID from `req.company.id` — never from URL or query params.

**Why:** Eliminates any possibility of a company user requesting data from another company's scope. A client can't substitute a different `companyId` in the URL because there is no `companyId` in the URL.

---

### 2026-04-17 · Super admin deactivate revokes company owner's refresh tokens

**Decision:** When super admin deactivates a company, ALL refresh tokens for the company's owner user are revoked inside the same transaction as the deactivation.

**Why:** Without revocation, the deactivated company owner could continue to refresh and hold valid access tokens. The `companyMiddleware.isActive` check would still catch them, but defense-in-depth dictates invalidating sessions proactively.

---

### 2026-04-17 · Super admin bootstrap via CLI script (not an endpoint)

**Decision:** First super admin is created via `npm run seed:superadmin -- --email <email> --password <password>`. No public endpoint exists for super-admin creation.

**Why:** Super admin is privileged; no public registration path should create them. CLI invocation requires access to the server + env, which is already a reasonable auth boundary for bootstrap. Further super admins can be added either by re-running the script or (later) via an authenticated super-admin endpoint.

---

### 2026-04-17 · Sort fields are whitelisted enums, never raw strings

**Decision:** All list endpoints (`customers`, `purchases`, `companies`) accept `sortBy` only from a fixed enum. The enum value is mapped server-side to an actual column name in a static object.

**Why:** Prevents SQL injection via `sortBy` (no string interpolation of user input into ORDER BY). Also prevents accidental ordering on non-indexed columns that would tank performance.

---

### 2026-04-17 · ILIKE search on non-indexed columns — acceptable at MVP scale

**Decision:** Search in customer/purchase/company lists uses `ILIKE '%...%'` on mobile, name, invoice_number, vehicle_number, email columns. No trigram / GIN index yet.

**Why:** Simpler. At sena-temp MVP scale (up to tens of thousands of rows per company), sequential scans are fine. Migrate to `pg_trgm` + GIN indexes when any single company exceeds ~50K customers/purchases.

**Revisit when:** `listByCompany` query time exceeds ~200ms p95.

---

### 2026-04-17 · QR rate limit key = `qrToken + mobile` (not companyId + mobile)

**Decision:** Rate limiter keys submissions by `(qrToken, mobile, window)`, not `(companyId, mobile, window)`, because companyId isn't resolvable until DB lookup (rate limiter runs before the handler).

**Why:** qrToken is 1:1 with company (unique constraint). Using qrToken directly avoids a DB lookup inside every rate-limit check. Semantically equivalent.

---

### 2026-04-17 · Customer identity upsert — match by (company, mobile, vehicle) for fuel; (company, mobile) for shop

**Decision:** `CustomerRepository.findByCompanyAndMobile(companyId, mobile, vehicleNumber)` uses `vehicle_number = :vehicleNumber` for fuel stations and `vehicle_number IS NULL` for shops. This matches the partial unique indexes at the DB level.

**Why:** Keeps service-layer identity logic in sync with DB-level uniqueness. Attempting to insert a duplicate still fails at the constraint (`23505` → `409`) as a safety net.

---

### 2026-04-17 · Option B (latest overwrite) for customer full_name + vehicle_number on submission

**Decision:** On every submission for an existing customer, `full_name` and `vehicle_number` on the customer row are updated to the latest submitted values. The original immutable copies live on the purchase row as `full_name_snapshot` + `vehicle_number_snapshot`.

**Why:** Customer preference — latest info is canonical. Historical truth preserved on the purchase row for audit.

---

### 2026-04-17 · Atomic aggregate update on customer row

**Decision:** `customers.total_invoice_amount` and `submission_count` are updated via SQL expressions (`total_invoice_amount = total_invoice_amount + $1`, `submission_count = submission_count + 1`), NOT read-modify-write in application code.

**Why:** Prevents lost updates under concurrent submissions for the same customer. Atomic at the row level.

---

### 2026-04-17 · Business-type field enforcement at service level

**Decision:** `QrService.assertBusinessTypeFields` throws 400 when:

- Company is `fuel_station` but submission has no `vehicleNumber`
- Company is `shop` but submission includes `vehicleNumber`

Joi schema accepts `vehicleNumber` as optional; the strict enforcement happens after we've resolved the company (which is where business type lives).

**Why:** Business type isn't known at Joi-validation time (it's on the company row, resolved via qrToken). Two-stage validation: shape first (Joi), semantics second (service).

---

### 2026-04-17 · Shared Redis client singleton for BullMQ + rate limits

**Decision:** Single ioredis connection lived at `src/config/redis.client.ts`, exposed via `getRedisClient()`. Used by both rate limiters and (later) BullMQ.

**Why:** One connection per process, lazy-reused. `lazyConnect: false` means it connects on creation. On shutdown, `closeRedis()` gracefully quits.

---

### 2026-04-17 · `/ready` now pings BOTH DB + Redis

**Decision:** `/ready` returns 200 only if both `SELECT 1` on DB succeeds AND `PING` on Redis returns PONG. 503 otherwise.

**Why:** Both are critical runtime dependencies. A server that can't hit Redis can't rate-limit the QR endpoint, so it shouldn't report ready.

---

### 2026-04-17 · Invoice amount max cap enforced at Joi boundary (env-tunable)

**Decision:** `invoiceAmount` has `Joi.number().max(config.MAX_INVOICE_AMOUNT)` enforcement. Default 10M. Env-tunable per deployment.

**Why:** Prevents top-spender ranking gaming via absurd values (e.g., 999,999,999.99 to top the leaderboard).

**Revisit when:** If legitimate customers routinely hit the cap, raise it via env.

---

### 2026-08-03 · Security-audit pass: findings and the decisions behind each fix

A full production-readiness audit of the backend. Recorded here because several fixes
look like style choices until you know what they were protecting against.

**Object-level `.strict()` removed from 19 Joi schemas.** Joi's object-level `.strict()`
sets `convert: false` for the whole subtree, which turns `.trim()` and `.lowercase()`
from transforms into _assertions_. `John.Doe@Gmail.com` was rejected with `"email" must
only contain lowercase characters` — every registration with a capital letter in the
email failed. Per-field `.strict()` (e.g. `termsAccepted`) is fine and is retained where
type coercion genuinely must not happen.

**PayPal capture split into claim → network → finalize.** The capture HTTP call used to
run _inside_ the DB transaction, holding one of only 10 pool connections for the whole
round trip to PayPal. The claim is now an atomic conditional UPDATE to `capturing`
(so a double-click cannot double-credit), the network call holds no connection, and a
short second transaction commits the result. `finalizeCapture` is shared with the webhook
so both paths cannot diverge.

**Webhook returns 500 on processing failure.** It returned 200 unconditionally, so PayPal
recorded delivery and never retried — a payment we failed to record was lost silently.

**Subscription extension is one atomic SQL statement** using `GREATEST(COALESCE(...))`

- `make_interval`, not read-modify-write. Two concurrent captures previously read the
  same expiry and one overwrote the other, losing a paid period.

**Refresh-token reuse revocation moved out of the detecting transaction.** It was
`revokeAllRefreshTokensForUser(...)` followed by `throw` _inside_
`AppDataSource.transaction` — and the throw rolled the revocation back. The code read
correctly and did nothing: replaying a spent token was rejected, but its successor
stayed live, which is exactly the token-theft case rotation exists to stop. The
transaction now only decides; a `SessionReuseDetected` marker carries the verdict out and
the revocation runs in its own transaction. **Verified by replaying a spent token and
then attempting to refresh with its successor** — 200 before the fix, 401 after.

**Login burns bcrypt time on a missing account** (`PasswordService.verifyAgainstDecoy`).
The error string was already uniform, but timing was not: measured 3.8ms for an unknown
email vs 315ms for a known one — an 83× gap readable without statistics, which enumerates
the whole customer list. After: 311ms vs 352ms.

**`rejectUnauthorized: false` removed from DB TLS.** It encrypted without authenticating,
so anything answering on the DB address could present a self-signed certificate and read
every password hash in transit. `DB_CA_CERT` supplies a private root where needed.

**`page` bounded to 10 000.** `?page=999999999` became `OFFSET 9999999980` on a joined
`getManyAndCount`, holding a pool connection while Postgres walked and discarded the index.

**body-parser errors map to 400/413.** They arrived at the catch-all and were reported as
500s, so client mistakes were indistinguishable from outages in our own error rate.

**Graceful shutdown awaits `server.close()`.** It was fire-and-forget, so `closeDatabase()`
ran while requests were still executing — in-flight captures and QR submissions lost their
writes on every deploy.

**Why documented at this length:** each of these has a plausible-looking "simplification"
that silently reintroduces the bug. The comment at each site explains the failure; this is
the index.

---

### 2026-08-03 · `subscription_status` is a cache; `computeEntitlement` is the spec

**Decision:** `subscriptionStatus.cron.ts` reconciles `companies.subscription_status` and
`is_active` hourly (`5 * * * *` UTC) with a set-based UPDATE whose CASE arms mirror
`utils/entitlement.ts` in the same precedence order.

**Why:** Access is decided in real time by `computeEntitlement`, never by the column, so
drift here degrades admin filters and UI badges but can never revoke a paying customer's
access. The reverse design — gating on the column — would make a stalled cron an outage.

Three load-bearing details: the update is guarded by `status <> target` so a re-run is a
genuine no-op rather than a full-table rewrite; it takes `pg_try_advisory_xact_lock` so a
second instance skips instead of contending; and it **never writes `deactivated_at`**,
because `AuthService.login` throws Forbidden on that column and an expiring customer must
still be able to log in to pay and to export.

**Verified:** seven synthetic companies, one per precedence branch, SQL result compared
against `computeEntitlement` on the same row — all seven agreed, and the second run
updated 0 rows.

**Revisit when:** adding a status to the CHECK constraint — the CASE arms here must be
updated in the same change, or rows will silently keep their previous status.

---

### 2026-08-04 · Trial identity registry — claim at grant, not at registration

**Decision:** `trial_identities` records which email addresses and phone numbers have
consumed their one free trial. The claim is made when the trial is **granted** (email
verification), **not** at registration as originally planned.

**Why the change:** the trial clock starts on email verification. Claiming at
registration would let anyone burn a stranger's trial by typing their address into a
form they never confirm — a denial-of-trial attack needing no account at all. Claiming
at grant means an identifier is only ever consumed by someone who proved control of the
login address. The registration response still carries an advisory
`trial: { eligible, durationDays }` so the success screen can be honest, and
`claimForTrial` re-decides authoritatively.

**A repeat identifier never blocks signup — only the free trial.** The company is
created, lands on `pending`, and `computeEntitlement` renders the paywall. The response
never says _which_ identifier matched: registration is unauthenticated, and naming the
field would turn it into an enumeration oracle over every contact detail we hold.

**Claimed:** `users.email`, `companies.contact_email`, `companies.contact_phone`.
**Not claimed:** `whatsapp_number` (optional, so trivially omitted, and often a shared
or agency number — claiming it burns a third party) and `customers.mobile` (QR
submitters are members of the public; someone who scanned a code at a filling station
must not be barred from later registering their own business).

**Addresses are canonicalised before hashing** (`utils/identity.ts`): lowercase, strip
`+tag` on every domain, strip dots on Gmail/Googlemail only, strip punctuation from
phone numbers. Without this the registry is defeated in one step — `owner+1@gmail.com`
and `o.w.n.e.r@gmail.com` are one inbox but three different strings, so one person farms
unlimited trials without even needing a disposable-mail service. Dot-stripping is
Gmail-only on purpose: `a.b@fastmail.com` and `ab@fastmail.com` really are two people.

**Stored as HMAC-SHA256 under `TRIAL_IDENTITY_PEPPER`, never SHA-256.** Every South
African mobile is ~10^8 candidates, so a bare digest is brute-forced back to plaintext
in minutes — the table would effectively hold a plaintext contact list for everyone who
ever signed up. `validateConfig` refuses to boot in production without the pepper.
**Rotating the pepper orphans every claim**, silently handing a second free trial to
everyone previously burned; treat it as permanent.

**Verified end-to-end:** company A verifies and burns 3 identifiers; company B using
`o.w.n.e.r+trial@gmail.com` still registers but gets no trial; company C reusing A's
phone with different punctuation is also refused; an admin release frees the identifier
and leaves the audit row; four concurrent claims of one hash produce exactly one winner;
hard-deleting a company keeps its ledger rows with `company_id` NULLed.

**Revisit when:** a legitimate customer is refused and support needs the release tool —
that lands in Phase 8 and must ship before this is considered complete, since it is the
only remedy for a mistakenly burned identifier.

---

### 2026-08-04 · Expiry notices — the marker stores the deadline, not a flag

**Decision:** `companies.trial_ending_notice_for` / `trial_ended_notice_for` /
`subscription_ended_notice_for` each hold **the deadline that was notified about**, and
the cron's guard is `notice_for IS DISTINCT FROM <deadline>`.

**Why not a boolean or a sent-at timestamp:** extending a trial or renewing a
subscription moves the deadline, which re-arms the notice by itself. With a flag, every
one of those sites would have to remember to clear it, and the one that got forgotten
would fail silently — that customer simply never hears from us again. `IS DISTINCT FROM`
rather than `<>` because both sides are nullable and `NULL <> x` is NULL, which would
match nothing and stop all mail.

**BullMQ `jobId` dedup alone is not enough**, which was the original plan. Jobs are
removed 24h after completion but the T-2d window is 48h wide and the cron runs hourly,
so the back half of the window would re-enqueue every hour. The database marker is the
real guarantee; the deterministic jobId is belt and braces.

**Claim inside a transaction, enqueue after it commits, release on failure.** Enqueuing
inside would let a Redis outage roll back the claim and would queue mail for rows that
might still roll back. Releasing on enqueue failure is what stops a Redis blip from
permanently consuming a customer's only warning — the marker is committed, so nothing
would ever look at that company again.

**Two bugs this work surfaced in already-written code, both found by execution:**

1. **`manager.query()` returns `[rows, rowCount]` for UPDATE/INSERT/DELETE — always,
   even with RETURNING** — while SELECT returns rows directly. `extendSubscription` read
   `rows[0]` and therefore got the array, not the row, so the capture path wrote NULL
   into `payments.subscription_starts_at`/`ends_at`, losing the record of which period
   each payment bought. No error anywhere: `query()` is typed `any` and the columns are
   nullable. Both sites now go through `utils/db.ts::returningRows`; use it for every
   raw RETURNING query.
2. **BullMQ rejects a `jobId` containing `:` unless it splits into exactly three parts.**
   `pwreset:${to}:${Date.now()}` passed only by accident — one extra segment would have
   turned every password-reset request into a 500. All job ids are now colon-free.

**Verified:** seven fixtures across the notice matrix — warned at T-2d, silent at T-5d,
notified at lapse, and correctly silent for a company that converted mid-trial, one that
is comped, and one an admin banned. Re-running the tick enqueues nothing; moving a
deadline re-arms exactly one notice; a trial that lapses before we ever warned gets only
the "ended" message and never a retrospective countdown.

---

### 2026-08-05 · Data export — batched keyset, not a server-side cursor

**Decision:** `GET /api/company/export/{customers,purchases}?format=csv|json` pages
through the data in 1000-row keyset batches and writes each batch straight to the
response.

**Why not `QueryBuilder.stream()`, which was the plan:** it needs `pg-query-stream`, and
more importantly it holds a database connection open for the _entire_ download. The pool
is capped at 10 and a merchant pulling 36k rows over a phone connection can hold one for
minutes — ten such downloads take the whole API down. Batching returns the connection
between round trips.

**Why keyset and not OFFSET:** `OFFSET n` makes Postgres walk and discard n rows per
batch, so cost grows quadratically with export size — the same bug bounded out of the
pagination schema. It is also unstable: a submission arriving mid-export shifts every
later page and silently drops a row. The predicate is a row-value comparison
`(ts, id) < ($2, $3)`, not the hand-written `ts < $2 OR (ts = $2 AND id < $3)`, because
the latter is easy to get subtly wrong when timestamps tie — and they do, since bulk
submissions land in the same millisecond.

**The first batch is fetched before a single byte is written.** Emitting the header
first felt natural and was wrong: it commits the 200, so any query failure then counts
as mid-stream and can only be signalled by destroying the socket — the customer gets a
truncated file instead of an error message. Found by testing the failure path, not by
reading the code.

**Mid-stream errors destroy the socket; they do not call `next(err)`.** Once the first
byte is out the status line cannot be retracted, and the error handler would append a
JSON envelope to half a CSV file — a body that is neither valid CSV nor valid JSON.

**CSV formula injection is the real security risk here**, and it is not theoretical:
`full_name` and `vehicle_number` are free text submitted by _anonymous_ members of the
public through the QR form, and the file opens in Excel on the merchant's machine. Cells
beginning `= + - @ \t \r` are prefixed with `'`. The original text is preserved rather
than stripped, so a surname legitimately starting with a hyphen survives. A UTF-8 BOM is
emitted so Excel on Windows renders accented names correctly instead of falling back to
the system codepage.

**`ip_address` and `user_agent` are excluded.** They are third-party personal data
collected from anonymous submitters for fraud prevention; putting them in a merchant
download is further processing for a different purpose (POPIA), and the merchant has no
use for them. Same reasoning excludes raw latitude/longitude.

**Mounted ABOVE `requireActiveSubscription`, with `requireExportAllowed` as a positive
assertion.** Export must survive expiry — it is the entire "download your data and
leave" half of the paywall, and both expiry emails link to it. The positive guard means
a future blanket `router.use(requireActiveSubscription)` breaks loudly rather than
silently holding a customer's own data hostage. It is also the one gate that _does_
refuse a deactivated (admin-banned) company: `canExport` is false only in that state.

**Verified end-to-end over HTTP:** a `pending` company exports successfully (200, CSV
attachment, dated filename, BOM confirmed on the wire via raw bytes — `fetch`'s `text()`
strips a BOM per spec and cannot observe it) while the same company's dashboard route
returns 403 `SUBSCRIPTION_REQUIRED`. Plus 21 service-level checks: a `=HYPERLINK` payload
lands quoted and apostrophe-guarded, 500 rows stream in 2 writes, no IPs or user agents
appear, an empty export is a valid header-only file rather than an error, and another
company's export contains none of our rows.

**Still outstanding from this phase:** the 30-day purge job for companies that decline
and leave. It needs an ordered cascade — the `ON DELETE RESTRICT` FKs mean a company
currently cannot be deleted at all.

---

### 2026-08-05 · Admin subscription controls, and two regressions `isActive` caused

**Two live regressions, both a direct consequence of `isActive` changing meaning from
"admin has approved this company" to "currently entitled to operate".** Both were
predicted in the plan and both were confirmed by execution.

1. **`deactivateCompany` guarded on `if (!company.isActive)`.** An expired or
   trial-expired company already has `isActive = false`, so the admin was told
   "Company is already deactivated" and refused — meaning **the one company most likely
   to need banning, the trial abuser sitting on the paywall, was the one company that
   could not be banned.** Now guards on `deactivatedAt != null`.

2. **`activateCompany` set `isActive = true` unconditionally.** Once `isActive` meant
   entitlement, "un-ban this company" silently became "give this company a free
   subscription": an expired account got a working dashboard and a live QR code with no
   payment, until the hourly cron happened to switch it back off. It now clears the ban
   and lets `computeEntitlement` decide, which for an expired account correctly grants
   nothing. Verified both ways — an expired company stays locked out, a company with
   paid time left is genuinely restored.

**Every admin write updates the entitlement projection in the same transaction** rather
than waiting for the cron. The admin must see the result of their own click, not a badge
that stays wrong for up to an hour.

**`extendTrial` stacks** using the same `GREATEST(COALESCE(...))` shape as
`extendSubscription` — adding three days to a trial with two left means five, not three
— and only sets `trial_started_at` when it is null, so extending does not restate when
the trial began and corrupt conversion analytics. Bounded at 365 days: an unbounded
value is one typo away from a perpetual free account, and a perpetual free account is
what `isComped` is for, where it is explicit and attributed.

**A comp requires a reason**, enforced in both the Joi schema and the service. Comping
is a money decision and an unexplained one is indistinguishable from a mistake six
months later. Revoking clears the reason rather than leaving a stale one attached to an
account that is no longer comped.

**`releaseTrialIdentity` is the safety valve** for the one real weakness in the trial
registry: a third party can burn someone else's contact email or phone by entering it
during their own registration. Without this tool that person can never take a trial and
has no self-service route back — which is why it ships alongside the registry rather
than after it. Only the masked preview ever leaves the server; the stored value is an
HMAC and is not reversible anyway, but returning less is the right default for a table
of contact details.

**Verified:** 30 checks covering both regressions in both directions, trial stacking,
comp grant/revoke/lapse, and the full release cycle including that releasing twice is
refused and the audit row survives.

---

### 2026-08-05 · Block 4 (database/API audit) — findings and fixes

**Ten foreign keys had no index.** Postgres indexes the _referenced_ side of an FK
automatically but never the _referencing_ side, which caused two distinct problems:

- **Reads.** `payments.company_id` was unindexed, so "this company's payment history" —
  the endpoint the billing page calls and the one PayPal Subscriptions will lean on
  hardest — was a sequential scan of the whole payments table per request.
- **Writes on the PARENT table**, the less obvious one. Every `DELETE` on `users`,
  `plans` or `companies` makes Postgres check each referencing table for orphans, and
  without an index that is a full scan per child table per row deleted. That is exactly
  the shape of the upcoming 30-day purge job, where it would have been catastrophic
  rather than merely slow.

**The monthly report is now aggregated in the database.** It previously paged through
every purchase in the month, 100 rows at a time and _sequentially_, then summed them in
the browser: a company with 10,000 purchases in a month meant 100 round trips before
anything rendered, with every row crossing the wire only to be reduced to ten numbers.

Two details in the replacement are load-bearing:

- **`RANK()`, not `ROW_NUMBER()`.** The old client code took the top ten _and everyone
  tied with the tenth_. RANK gives tied totals the same rank, so `rnk <= 10` reproduces
  that exactly; ROW_NUMBER would silently drop one of two identical top spenders.
- **A half-open window `[first of month, first of next month)`, not `BETWEEN`.**
  `BETWEEN` includes the upper bound, so a purchase landing exactly at midnight on the
  1st would be counted in two months at once.

**And it fixed a timezone bug in passing.** The frontend built
`new Date(year, month, 1)` in _local_ time and then called `.toISOString()`, so in any
timezone behind UTC the "1st of the month" became the previous month's last day and the
report silently covered the wrong window. The endpoint takes year and month as numbers,
so there is no date to mis-convert.

Money stays a **string** end to end (`numeric(14,2)` → JSON string → parsed only for
display). Passing it through a JS float loses cents once totals get large.

**Checked and found sound:** every company-scoped repository method encodes the scope in
its name and its WHERE clause (`findByIdInCompany`, `listByCompany`), and a
cross-tenant read returns nothing — verified against a second company. The webhook's
`findByPaypalOrderId` is deliberately not company-scoped (a webhook has no company
context) and is safe because the request is PayPal-signature-verified before it runs.

**Verified:** the aggregate matches a straight SQL sum to the cent, ties at tenth place
are all included, an empty month returns zeros rather than erroring, another company's
report excludes our rows, and every malformed query parameter returns 400 rather than
500 — checked with a real authenticated session, since auth runs before validation and
an unauthenticated probe only ever proves "not a 500".

**Still open from this block:** the "All customers" report still paginates client-side
100 rows at a time. It is bounded by customer count rather than purchase count, so it is
far smaller than the monthly report was, but it deserves the same treatment.

---

### 2026-08-05 · Phase 6 · PayPal Subscriptions — cancel, upgrade, downgrade

**The gate is cleared: `DAY` intervals work on this account.** Probed live —
`DAY/7`, `DAY/15`, `DAY/21` and `DAY/30` all return `ACTIVE`. So every plan duration
maps exactly and the feared "15-day has no recurring equivalent" problem does not exist.
`WEEK/1`, `WEEK/3` and `MONTH/1` were verified too and are documented in the sync script
as a fallback if another account ever refuses `DAY`.

**`subscription_expires_at` remains the single access gate.** Recurring subscriptions
never gate access directly — they only push that column forward when a payment lands.
That is what lets the Orders era, the trial era and the recurring era coexist with no
branching in `computeEntitlement`, and it means a missed webhook cannot lock out
somebody who has actually paid.

**No cutover, no backfill.** An Orders payment cannot be converted into a subscription;
that needs a fresh buyer approval we cannot force. Instead `subscribe()` sets
`start_time` to the later of now and the customer's current access end, so a legacy
customer with 20 days left starts billing in 20 days. **The same line handles mid-trial
conversion**, which is why there is no separate migration path for either.

**Emulated cancel-at-period-end.** PayPal has neither that nor a resume. We cancel at
PayPal immediately so nobody is charged again, and deliberately do NOT touch
`subscription_expires_at`, which leaves the customer the time they bought. Deferring the
cancel to a cron would risk charging someone who cancelled — and a billing bug that
_takes_ money is far worse than one that grants a few free days. The cost is that
cancellation is terminal: no resume, only resubscribe, and the UI must say so.

**Two statuses with no PayPal counterpart, both load-bearing:** `past_due` (PayPal
retries inside an already-paid period, so access must not lapse but the UI should warn)
and `pending_cancel` (the emulation above). This is exactly why we keep our own state
machine rather than mirroring PayPal's string.

**Plans are synced by a script, never a migration.** Migrations run in one transaction
and there is no way to make a remote HTTP call transactional with the database: a PayPal
timeout would roll back the schema while leaving real billing plans behind, and a
success followed by a later rollback orphans them permanently. Not lazy-on-subscribe
either — two simultaneous subscribers would each create a plan. Idempotent, with a
deterministic `PayPal-Request-Id` per plan row.

**Three guards are in the database, not the application**, because each closes a race
that application logic cannot:

- `uq_subscriptions_one_live_per_company` — two tabs both completing approval would
  otherwise leave a company paying twice.
- `uq_payments_sale_id` — PayPal resends `PAYMENT.SALE.COMPLETED` and guarantees neither
  ordering nor deduplication, so a check-then-insert loses the race.
- `chk_payments_status` — the status CHECK was **missing entirely**; the column had been
  accepting arbitrary strings since the table was created.

**A webhook bug this work surfaced and fixed:** the event row is claimed _before_
dispatch, which is what makes idempotency race-proof — but it meant a transient dispatch
failure left the claim behind, so PayPal's retry was treated as a duplicate and the
event was lost permanently. The claim is now released on failure before rethrowing. Same
class of bug as the expiry-notice release, found the same way: by testing the failure
path rather than reading the code.

**Ordering is never assumed.** Events whose `create_time` predates `last_event_at` are
discarded, otherwise a delayed ACTIVATED resurrects a subscription the customer already
cancelled. And webhook bodies are never trusted — the state is read back from PayPal,
since the body is a snapshot from when the event was queued.

**Admin deactivation now cancels the subscription.** Without it we kept charging a
company we had just banned, every renewal, with no way for them to log in and stop it.

**`Subscription` deliberately does not extend `BaseEntity`** — same trap as
`trial_identities`. A soft-deleted row would vanish from every query while still holding
its slot in the one-live-per-company partial index, and this is financial history that
should never be deletable anyway.

**Verified:** 27 checks, including two real subscriptions created against PayPal
sandbox. Trial conversion starts billing in exactly 5 days, a legacy customer with 20
days left starts in exactly 20, an expired company starts now, a second subscription is
refused by both the service and the index, cancel leaves `subscription_expires_at`
untouched and access live, and a replayed sale cannot be credited twice.

**What still needs a human in a browser:** the approve → ACTIVE → first charge cycle,
and abandoning the `/revise` redirect. Neither can be driven from here.

---

### 2026-08-05 · The PayPal webhook is exempt from the global rate limiter

**Decision:** `globalApiLimiter` skips `/api/payments/paypal/webhook`.

**Why it matters more than it looks:** every delivery arrives from PayPal's own IP
range, so they all share a single rate-limit key. The limiter is 100 per 15 minutes,
and one renewal day sends at least two events per renewing customer
(`BILLING.SUBSCRIPTION.*` plus `PAYMENT.SALE.*`) — roughly 50 simultaneous renewals is
enough to start 429ing.

A 429 is not a harmless throttle here. PayPal treats a non-2xx as a delivery failure,
retries, and **disables an endpoint that keeps failing**. So the busiest billing day of
the month is precisely when we would lose the ability to credit payments at all —
silently, for every customer at once, at the moment it costs the most.

The endpoint is not left unprotected: it verifies the PayPal signature before doing
anything, and every event is deduplicated on its event id.

**Verified by execution** with the limit lowered to 5/minute: an ordinary route returns
`200 200 200 200 429 429 …` while twelve consecutive webhook deliveries all return 200.

---

### 2026-08-05 · Verifying the two functions that had never run

`creditCycle` — the function that grants a paying customer their access on **every
renewal** — had never executed even once, and contained raw SQL whose `ON CONFLICT`
clause infers a _partial_ unique index, a construct Postgres had therefore never
parsed. The earlier "cannot double-credit" test inserted rows by direct SQL, so it
proved the index worked, not the function.

Now executed and verified end to end: a cycle credits exactly one ledger row with the
right kind/status/amount and no order id, extends access by exactly the plan duration,
switches the company on, re-arms the expiry notice, and stacks correctly across two
cycles. A replay returns false, leaves the expiry untouched and writes no second row. A
sale for an unknown subscription returns false rather than throwing.

Also confirmed on the same run: **activation alone does not grant access** — money has
to land first; `past_due` does not revoke access; a stale out-of-order `CANCELLED` does
not overwrite newer state; and a local `pending_cancel` is not clobbered by PayPal's
`CANCELLED`, which is what preserves already-paid-for access after cancelling.

**`custom_id` is echoed back by `GET /v1/billing/subscriptions/{id}`** — confirmed
against sandbox. That means the ownership guard in `SubscriptionService.confirm`
(`remote.custom_id !== companyId`) is live code, not a dead branch.

---

### 2026-08-05 · Account deletion anonymises; it does not DELETE

**Decision:** "Export and leave" records an explicit request, waits 30 days, then erases
third-party personal data and **anonymises** the company and owner rows in place. It
never runs `DELETE FROM companies`.

**Why not a hard delete:** `customers`, `purchases`, `payments` and `subscriptions` all
reference `companies` with ON DELETE RESTRICT, so it is impossible without relaxing
those. The tempting fix — switching them to CASCADE — would be wrong, because two of
them are the money ledger. Deleting `payments` destroys the record of what we charged
and when, which is both a bookkeeping obligation and the only way to answer a chargeback
months later. So erasure is split by what the data actually _is_:

| Data                        | Treatment                  | Why                                                                                                                                                                                          |
| --------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purchases`, `customers`    | **hard deleted**           | Third-party personal data from anonymous members of the public, held only so the merchant could run their scheme. No basis to keep it once they leave, and the most sensitive thing we hold. |
| `companies`, owner `users`  | **anonymised in place**    | Every personal field scrubbed; row survives so financial records referencing it stay valid.                                                                                                  |
| `payments`, `subscriptions` | **retained untouched**     | Money records, now pointing at an anonymised company.                                                                                                                                        |
| `trial_identities`          | **deliberately untouched** | HMACs, not personal data. Clearing them would make account deletion a way to earn a second free trial — the exact abuse the registry exists to stop.                                         |

**Request-driven, never automatic.** `deletion_requested_at` is only ever set by an
explicit act. Purging on the basis of an expired subscription would mean a customer who
forgets to renew for a month loses everything — the most destructive possible default.
Expiry and erasure are unrelated events and the cron treats them so. Verified: a company
expired for 400 days that never asked is not picked up.

**Billing stops at request time, access does not.** The subscription is cancelled
immediately so nobody who has asked to leave is charged again, while
`subscription_expires_at` is left alone — so they keep working and can still export right
up to the purge. Cancellation is best-effort: a PayPal outage must not block someone from
requesting deletion, and the purge cancels again before erasing.

**Daily at 03:20 UTC, not hourly.** The grace period is 30 days, so hour precision buys
nothing, and this is the most destructive job in the system — fewer runs, fewer chances
to be wrong. Each company purges in its own transaction and a failure is logged and
skipped, so one awkward account cannot indefinitely block erasure for everyone behind it.

**The owner's password is set to `ACCOUNT_DELETED`** — a literal bcrypt can never
produce — and every refresh token is revoked, so an open tab cannot keep working against
an account that no longer exists.

**Verified:** 34 checks. Request → grace → cancel → re-request; the cron purges only aged
requests; purchases and customers erased while payments survive; every personal field on
both rows scrubbed; sessions revoked; re-running is a no-op; purging without a request is
refused; and a burned trial identity survives, so deleting an account does not hand back a
free trial.

---

## 2026-08-22 — Reports render on the server, not in the browser

**Decision:** PDFs are produced by the backend (`src/pdf/`), using jsPDF + autotable
under Node. The browser fetches finished bytes.

**Why:** not a preference. The expiry email attaches the top-ten report, and a browser
that is not running cannot render anything. The only alternative was two
implementations — one for the email, one for the download — which would have drifted,
and the drift would only ever surface in a customer's inbox.

**Delivery is an authenticated fetch, not a signed URL.** A browser navigation carries
no `Authorization` header, so a link-based download needs a token in the URL — creating
something that grants access to customer names and phone numbers and survives in
browser history, access logs and forwarded messages. The current approach never creates
such a URL. Revisit only if report sizes make browser-side buffering a real problem;
at the time of writing the largest company has 16 customers.

**Not streamed, and capped at 5,000 rows.** A PDF's page count and layout are only
known once every row is composed, so it is built in memory. The cap fails with copy the
customer can act on rather than exhausting the process, and the query orders by spend so
a company that ever hits it keeps its biggest customers.

**Top-three bolding is keyed on rank, not row index.** A three-way tie for first bolds
three rows; the fourth-placed customer is not bolded for sitting in row three. The
top-ten cutoff keeps everyone level with tenth place rather than slicing at exactly ten
— indefensible when the list decides a prize.

**The vehicle column is omitted for shops.** `QrService` rejects the field outright for
`business_type = 'shop'`, so the column was blank on every row. Because `columnStyles`
is index-keyed, the indices are derived from whether the column is present; hard-coding
them styled Purchases as the money column for every shop.

---

## 2026-08-22 — Expiry retention is 15 days, and the purge ships disabled

**Decision:** `EXPIRY_RETENTION_DAYS = 15`, one constant read by both the email copy and
the purge job. `EXPIRY_PURGE_ENABLED` defaults to **false**.

**Why one constant:** the email tells the customer a number and the job acts on one. If
they ever disagree, data is either deleted earlier than promised or kept past what was
stated, and neither is discoverable until after it has happened.

**Why disabled by default:** this is the only irreversible operation in the platform. A
feature that starts deleting customer data because a deploy happened is not something
anyone should discover afterwards. The startup log states plainly which mode it is in,
and `findDue()` is exposed separately so the exact set can be read before anything is
erased.

**Lapsing is not leaving.** The purge erases customers and purchases only. Account,
login, identity and payment history survive so the company can return and start again.
That is `data_purged_at`, deliberately distinct from `anonymized_at`.

**The deadline is re-checked inside the transaction with the row locked.** The candidate
list is read before the loop; a company that renews in between must not be erased on the
strength of a check made seconds earlier.

---

## 2026-08-22 — A failed delivery hands its notice back to the cron

**Decision:** when a `subscriptionNotice` job exhausts its BullMQ retries, the worker
clears the `*_notice_for` marker **and removes the job**.

**Why:** the cron released its claim if the _enqueue_ threw, but an enqueue that
succeeded and a delivery that failed hours later looked identical to success. The marker
stayed set, the claim query skips any company whose marker equals its deadline, and the
notice was gone permanently. The SMTP outage that began 22 Aug swallowed a real
customer's trial-ended email this way.

**Only after the final attempt.** `worker.on("failed")` fires on every attempt;
releasing early hands the notice back while a retry is still pending and the customer
gets it twice.

**The dead job must be removed too.** Notice job ids are deterministic (kind, company,
deadline) and `queue.add` silently drops a duplicate id. Releasing the claim without
removing the job produces a cron that faithfully re-claims and re-enqueues forever while
nothing is ever sent.

**Verified in production** during the live SMTP outage: "claim released so the cron will
retry it", marker cleared, job key gone.

---

## 2026-08-22 — Reminders ask for the renewal and nothing else

**Decision:** emails sent _before_ a deadline never mention downloading or leaving.
Post-expiry emails do, because the customer has to be told what happens to their data.

**Why:** every one of these closed with "if you'd rather stop here" / "if you'd rather
not continue", plus a `Download my data instead` button in the HTML of all of them —
including the reminders sent while the plan was still running. An email whose whole
purpose is to win a renewal was offering the exit.

Enforced by test, in both text and HTML: the first fix corrected the text and missed the
markup entirely.

**Paid plans now warn at 24 hours.** Trials warned at 48h; paid subscriptions warned not
at all, so the first a paying customer heard was that their plan had already stopped.

---

## 2026-09-26 — Payment audit fixes: what changed and what was left alone

From PAYMENT-AUDIT-2026-09-26.md.

- **Webhook verify: only PayPal's FAILURE is "invalid".** No webhook id, or PayPal's verify
  API erroring, now throws → 5xx → PayPal retries. It used to answer 200 and lose the event.
- **Renewal refunds/chargebacks revoke.** `PAYMENT.SALE.REFUNDED/REVERSED` find the
  `subscription_cycle` payment by `sale_id` and take back that cycle's window, same as a
  one-time capture. Partial refunds are flagged only (audit `payment.partial_refund`).
  `PAYMENT.SALE.DENIED` unchanged (never credited, nothing to take back).
- **Disputes are recorded, not acted on** (`payment.dispute`, entity `paypal_dispute`). If
  PayPal rules for the buyer the money moves as a REFUNDED/REVERSED event.
- **Stuck webhook claims are taken over after 5 minutes** (unprocessed only).
- **A declined capture hands the payment back to `pending`** (`PaypalDeclinedError`), so the
  buyer can retry at once. ORDER_ALREADY_CAPTURED is not a decline.
- **Dead subscription rows are retired** (hourly cron + in subscribe): `pending_cancel` once
  paid time is over → `cancelled`; `pending` older than 3h → `expired`, **but only after
  PayPal confirms it is still APPROVAL_PENDING (or unknown)**. An approved one whose webhook
  is late gets its state applied instead: expiring it would leave a subscription that bills
  and is never credited (found by the security review). Both used to hold the
  one-live-per-company index forever.
- **Webhook pre-filter:** missing PayPal headers, a non-JSON body, or a cert URL off
  paypal.com → "invalid" (2xx) without a PayPal call.
- **Known gap, accepted:** a renewal refund that arrives before its COMPLETED was credited
  finds no payment and is logged; the late COMPLETED then credits it. Needs unlucky
  ordering plus a refund; the error log is the signal.
- **Daily 03:20 UTC subscription reconcile** against PayPal: re-read state, credit completed
  sales from the last 5 days through `creditCycle` (idempotent on sale id).
- **Webhook ledger stores no buyer PII** (`withoutPayerDetails`); logger redacts `payer`,
  `subscriber`, `email_address`.
- **Go-live:** `sync-paypal-plans --reset` + README runbook, instead of a per-id env column.
- **Plan price must be > 0.**

**Left alone, on purpose:** captured-amount comparison for orders (the amount is set by us
server-side on order creation), PayPal-Request-Id on orders (double capture is already
blocked by the `capturing` claim), abandoned `pending` order cleanup (cosmetic), explicit
dunning threshold (PayPal default; access fails safe), same-timestamp event ordering.

---

## 2026-10-03 — Data is kept 7 days, for both lapsed plans and closed accounts

**Decision:** `EXPIRY_RETENTION_DAYS` 15 → **7** and `DELETION_GRACE_DAYS` 30 → **7**
(user's call). The frontend mirrors both in `frontend/src/lib/retention.ts`, which the
billing banner, paywall and both deletion cards read; change all three together.

**The expiry purge is still OFF in production** (`EXPIRY_PURGE_ENABLED` unset), so until
it is switched on, lapsed data is in fact never removed. Switching it on erases, at the
next 03:20 UTC run, every non-comped company whose access ended more than 7 days ago
(customers and purchases only; account, login and payment history stay). Preview the
set with the `findDue` query before enabling.

---

## 2026-10-06 — Trial and comp companies can buy lucky-draw spins

**Decision (user's):** a company on a free trial or on admin-granted free access can buy
spins at the admin price, but only once its free spins are used up. Bought spins last
until the trial / free access ends, following admin extensions. Paid-plan companies are
unchanged (they can buy at any time).

**How:** the add-on has no plan (`payments.plan_id` NULL, allowed only for `spin_addon`
by CHECK) and names the period it was bought for in `payments.draw_period_key`
(`trial:<ms>` / `comp:<ms>`, the key `lucky_draws` uses). `activePeriods` gives those
spins their OWN pool, `buy:<key>`, next to the period's free spins: mixed into one count,
a later drop in free spins (admin lowering the setting, the company paying or being
comped mid-trial) used up the paid ones first (code review, 2026-10-06). Free spins sort
first within a window. Winners are per period across both pools: the eligibility query
and the unique index `uq_lucky_draws_one_win_per_base_period` both strip `buy:`. Keys are
built in SQL only, never JS, so their millisecond rounding matches recorded draws.

**Every comp has a draw window**, even one granted with 0 spins (`compSpinWindowStart`,
onboarding); legacy ones were backfilled to the first comp grant after the last revoke.
Revoking a comp ends its bought spins with it ("valid until the free access ends").

**Guards:** the server refuses a purchase while free spins remain, and refuses capture if
that exact trial/comp period ended while the buyer was on PayPal (a comp granted
meanwhile does not end the trial). `LuckyDrawService.spinPurchaseOption` is the one rule,
used by both the purchase and `canBuySpins` on `GET /company/draws` (including the
USD-plan check), so the UI never offers what the server refuses.
