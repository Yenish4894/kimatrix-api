---
name: be-decisions
description: Decision log for non-obvious architectural and schema choices on sena-temp backend. Update whenever a locked-in decision is made so we don't re-litigate past debates.
---

# sena-temp Backend Decision Log

> One row per decision. Format: **Date · Decision · Why · Alternatives considered · When to revisit.**
> Two sections: **Locked** (decided + to be implemented) and **Pending** (awaiting input or deferred to later phase).

---

## Pending decisions / open questions

| #   | Topic                                                                                   | Status                       | Awaiting / Revisit trigger                         |
| --- | --------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------- |
| P1  | Email verification on company registration                                              | Awaiting client confirmation | User to confirm with client                        |
| P2  | Mobile number verification via SMS OTP                                                  | Awaiting client confirmation | User to confirm with client                        |
| P3  | Submission success response shape (just "Thank you" vs include cumulative spend + rank) | Awaiting client confirmation | User to confirm with client                        |
| P4  | Payment gateway (Flutterwave vs alternative)                                            | Client decision pending      | Before building payment webhook                    |
| P5  | Plan structure (fixed 15/30 vs custom lengths, pricing, currency USD/XOF)               | Client decision pending      | Before building subscriptions                      |
| P6  | QR code PDF layout (branding, size, QR placement)                                       | Design decision              | Phase 4                                            |
| P7  | System message language (English only for MVP vs bilingual EN+FR now)                   | Not discussed                | Before UI-facing error messages                    |
| P8  | Password policy strengthening via haveibeenpwned range-query API (free)                 | To implement                 | When auth hardening begins                         |
| P9  | JWT key rotation / versioning strategy                                                  | Keep in consideration        | Before first production deploy                     |
| P10 | Column-level PII encryption (envelope pattern)                                          | Future improvement           | When scaling beyond small pilot                    |
| P11 | Failed-login tracking + account lockout                                                 | Improvement phase            | After MVP, before public launch                    |
| P12 | Compliance: privacy policy, retention policy, right-to-be-forgotten process             | Post-dev review              | Before first real company onboards                 |
| P13 | Cursor-based pagination migration                                                       | Optimization trigger         | When any single company exceeds ~50K purchases     |
| P14 | Time-based partitioning on `purchases` table (monthly)                                  | Scale planning               | Before total purchase count hits 10M               |
| P15 | Read replica for report generation                                                      | Scale planning               | Post-MVP, when report latency matters              |
| P16 | Circuit breakers (opossum or similar) around external calls                             | Integration-dependent        | When integrating payment gateway or 3rd-party APIs |
| P17 | Column-level PII encryption                                                             | Security hardening           | Before scaling to many companies                   |
| P18 | Dockerfile + docker-compose + CI/CD pipeline                                            | Deployment prep              | At deployment time                                 |

---

## Locked decisions (to implement)

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

3. **Helmet hardened** — `app.ts` passes `{ contentSecurityPolicy: false (API doesn't serve HTML), crossOriginResourcePolicy: { policy: "cross-origin" } (needed for CSV downloads from FE origin), hsts: { maxAge 1y, includeSubDomains, preload } }`.

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
**Current unpaginated by design:** `GET /api/company/customers/export` (CSV), `GET /api/company/purchases/export` (CSV). Future report endpoints (top-10, all-customers PDFs) follow the same exemption.

**Defaults:** `page=1`, `limit=10`, `max limit=100` (enforced via `paginationSchema`).

**How to apply on every new endpoint:**

1. If it returns a list for in-app rendering → use `paginationSchema` + `BaseController.paginationResponse()` + repo method that returns `{ items, total }`.
2. If it returns a bulk export (CSV/PDF) → no pagination. Document the exemption in `be-endpoints.md`.
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

- Pending activation → `403 "Your account is awaiting activation. You'll be able to log in once your payment is verified."`
- Admin-deactivated → `403 "Your account has been deactivated. Please contact support."`

**Why:** Previously, both pending and deactivated companies hit a generic message after password verification — confusing for legitimate users (especially newly-registered ones who couldn't tell why login failed). Revealing state AFTER password verification is safe: the caller has proven account ownership, so the leak window is closed. Password-spraying attackers hit the uniform `Invalid credentials` 99.9%+ of the time and never reach the state branch.

**Distinguishing pending vs deactivated:** uses `companies.deactivatedAt IS NULL` (the same derived state used by the admin three-state badge).

**Affected:**

- `AuthService.login` — branched the company-state check; added `ForbiddenError` import
- `be-flows.md`, `be-endpoints.md` — login flow + error cases updated
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

**Decision:** New companies are created with `is_active=false` and **no tokens are issued** at registration. The user receives a "pending activation" message and cannot log in until a super admin activates them (typically after manual payment verification). The activate/deactivate endpoints already exist; "first activation" reuses the same path as "reactivate."

**Why:** Until the payment gateway is integrated, payment verification is manual. The previous auto-activation flow let companies use the platform without paying. This change closes that loop with a one-line schema flip (the same hook flagged in `be-schema.md`'s adaptability anchors), and surfaces three states the admin UI can render: pending / active / deactivated (distinguishable via `is_active` + `deactivated_at`).

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

**Decision:** Cover audit needs via scattered who/when fields on affected tables (`users.password_changed_at`, `users.last_login_at`, `companies.joined_at`, `companies.deactivated_at/by`). Rely on SendGrid dashboard + BullMQ job retention for email visibility. PDF reports planned as on-demand endpoints.

**Why:** MVP scope. Adding these tables is additive — defer until needed. Compensating fields cover the "who did what, when" trail for v1's sensitive actions.

**Revisit when:** Compliance requirement, or support needs "why didn't X email arrive" beyond what SendGrid surfaces.

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

**Decision:** All outgoing SendGrid calls go through a BullMQ email queue with retry + exponential backoff. No synchronous SendGrid calls in request handlers.

**Why:** SendGrid outages/slowness shouldn't block API responses. Retries handle transient failures. Dead-letter monitoring flags permanently failed emails for manual review.

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
