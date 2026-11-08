# sena-temp Backend Schema

> **How to read this file.** Living schema reference, appended over time; the entity files in `src/entities/` are the final word. Last reconciled 2026-11-08.

> Update this file whenever an entity is added, modified, or removed. Keep in sync with `src/entities/` and `migrations/`.

## Status

14 entities in `src/entities/`, 27 migrations. Last verified 2026-11-08.

## Conventions

- All tables use **UUID** primary keys (`uuid_generate_v4()`)
- DB columns are `snake_case`, TS properties are `camelCase`. `name:` in `@Column` only when they differ.
- Timestamps: `created_at`, `updated_at`, `deleted_at` (soft delete) on every table via `BaseEntity`. All `timestamptz`.
- Foreign keys: explicit `@JoinColumn({ name: "snake_case_id" })`. No explicit FK columns on entities — relation property only (access via `entity.relation.id`).
- Monetary amounts: stored as `numeric(14, 2)` — never float. Returned as `string` by TypeORM; use SQL expressions for arithmetic.
- Phone numbers: stored in E.164 format (`+227XXXXXXXX`), varchar(20).
- Enums: stored as `varchar` + TypeScript string-literal unions from `as const` arrays + `@Check` constraints (not PG enums — avoids migration friction).
- No `readonly` on class members per user preference.

## Tables

14 entities today: `users`, `companies`, `customers`, `purchases`, `tokens`, `plans`, `payments`, `subscriptions`, `paypal_webhook_events`, `app_settings`, `admin_audit_log`, `bulk_email_logs`, `trial_identities`, `lucky_draws` (plus `site_visits` and `email_change_tokens`). The original seven:

| #   | Table       | Purpose                                                                         |
| --- | ----------- | ------------------------------------------------------------------------------- |
| 1   | `users`     | Auth record for all roles; `user_type` column with CHECK constraint             |
| 2   | `companies` | Company profile (1:1 with users via `owner_user_id`); holds subscription window |
| 3   | `customers` | Per-company customer records                                                    |
| 4   | `purchases` | Purchase submissions, enforces invoice uniqueness                               |
| 5   | `tokens`    | Unified refresh + password reset tokens                                         |
| 6   | `plans`     | Subscription plans (seeded: 7/15/21/30 day in USD)                              |
| 7   | `payments`  | PayPal payment records; one row per order attempt                               |

### `plans` table

| Column        | Type          | Notes                                |
| ------------- | ------------- | ------------------------------------ |
| id            | uuid PK       |                                      |
| name          | varchar(100)  | e.g. "30 Day Plan"                   |
| duration_days | int           |                                      |
| price         | decimal(10,2) |                                      |
| currency      | varchar(3)    | "USD"                                |
| is_active     | boolean       | soft-disable a plan without deleting |

### `payments` table

| Column                 | Type                 | Notes                                                                                                         |
| ---------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| id                     | uuid PK              |                                                                                                               |
| company_id             | uuid FK → companies  | ON DELETE RESTRICT                                                                                            |
| plan_id                | uuid FK → plans      | ON DELETE RESTRICT; NULL only for a trial/comp spin add-on                                                    |
| draw_period_key        | varchar(64) null     | trial/comp spin add-on: the draw period it joins (`trial:<ms>`/`comp:<ms>`); CHECK pairs it with plan_id NULL |
| paypal_order_id        | varchar(64) UNIQUE   | PayPal's order ID                                                                                             |
| status                 | varchar(20)          | pending \| captured \| failed \| cancelled                                                                    |
| amount                 | decimal(10,2)        | snapshot of plan price at time of purchase                                                                    |
| currency               | varchar(3)           | snapshot of plan currency                                                                                     |
| captured_at            | timestamptz nullable | when PayPal capture completed                                                                                 |
| subscription_starts_at | timestamptz nullable | start of subscription window                                                                                  |
| subscription_ends_at   | timestamptz nullable | end of subscription window                                                                                    |
| paypal_response        | jsonb nullable       | full PayPal API response (audit trail)                                                                        |

### `companies` additions (migration 1748100000000)

| Column                  | Type                     | Notes                                                          |
| ----------------------- | ------------------------ | -------------------------------------------------------------- |
| current_plan_id         | uuid FK → plans nullable | last plan purchased                                            |
| subscription_expires_at | timestamptz nullable     | end of PAID time. **null = never purchased — NOT "unlimited"** |

### `companies` entitlement + trial additions (migration 1785369600000)

| Column                  | Type                           | Notes                                                                      |
| ----------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| subscription_status     | varchar(24) NOT NULL 'pending' | CHECK `chk_companies_subscription_status`. **Projection only** — see below |
| is_comped               | boolean NOT NULL false         | The explicit admin free-override. Replaces the old null-expiry hack        |
| comped_until            | timestamptz nullable           | null while `is_comped` = perpetual comp                                    |
| comp_reason             | varchar(255) nullable          | required by the admin API when enabling                                    |
| comp_granted_by_user_id | uuid FK → users nullable       | SET NULL. Audit                                                            |
| trial_started_at        | timestamptz nullable           | null = never granted a trial. Inert until Phase 3                          |
| trial_ends_at           | timestamptz nullable           | separate from `subscription_expires_at` on purpose — see below             |

Status values: `pending | trialing | active | trial_expired | expired | past_due | deactivated`
(`past_due` is in the CHECK already but unused until recurring billing ships — adding a CHECK value later needs a DROP/ADD with a full validation scan.)

`trial_ending_notice_for`, `trial_ended_notice_for`, `subscription_ended_notice_for` (all TIMESTAMPTZ NULL) are the expiry-email send-once markers. Each stores **the deadline it notified about**, not a flag — the cron guards on `notice_for IS DISTINCT FROM <deadline>`, so extending a trial or renewing a subscription re-arms the notice automatically and there is no flag for anyone to forget to reset.

Indexes: `idx_companies_subscription_status`; partial `idx_companies_trial_ends_at` and `idx_companies_subscription_expires_at` (both `WHERE ... IS NOT NULL AND deleted_at IS NULL`).

**`subscription_status` is a materialized projection, never the gate.** Access is decided by `computeEntitlement(company, now)` (`src/utils/entitlement.ts`) called in real time on every request. The column exists so the expiry cron, admin filters and platform stats get an indexed value. Middleware never reads it — that way a stalled cron or clock skew cannot lock out a paying customer.

The projection is maintained by `src/cron/subscriptionStatus.cron.ts`, hourly at `5 * * * *` UTC. It also keeps `is_active` in step (a trialing company needs `is_active = true` or `QrService.submitPurchase` rejects its scans). The cron's CASE arms mirror `computeEntitlement`'s precedence and **must be updated in the same change as that function** — including whenever a value is added to `chk_companies_subscription_status`, or rows will silently keep their previous status. It never writes `deactivated_at`: that column makes `AuthService.login` throw Forbidden, and an expiring customer must still be able to log in to pay and to export.

**Why `trial_ends_at` is not folded into `subscription_expires_at`:** `PaymentService.computeSubscriptionDates` stacks a newly-purchased plan on top of any live expiry. A trial stored in that column would therefore gift its remaining days to anyone who subscribes mid-trial. Separate columns keep the money path untouched and preserve trial history for conversion analytics.

## Since the original design

All of the once-deferred pieces shipped: expiry notices and purge (`subscriptionStatus.cron.ts`, `expiredDataPurge.cron.ts`), static per-company `qr_token`, `admin_audit_log`, `bulk_email_logs`. `lucky_draws` (migrations `1787112000000` to `1787284800000`) holds winner rows with name and masked-mobile snapshots, keyed by period (`trial:<ms>`, `comp:<ms>`, paid window, `buy:<key>`), unique on `uq_lucky_draws_one_win_per_base_period`. `subscriptions` and `paypal_webhook_events` back the (hidden) auto-renew path. Columns live in the entity files; add a section here when you touch one.

## Adaptability anchors

- `companies.is_active` + `companies.joined_at` + `companies.deactivated_at/by` cover v1 activation state. When payments ship, add `subscriptions` table; activation gate becomes `is_active AND has_active_subscription()`.
- Service-layer seam: consumers call `CompanyService.getActivationStatus(companyId)` (to be built) instead of reading `company.is_active` directly — returns `{ active, reason?, expiresAt? }`. Today returns only `active`; future returns subscription window with no caller changes.
- PDF reports are planned as on-demand API endpoints in v1. Future expiry cron is a thin scheduler over the same report-generation service.
- Registration flow (current): company registers as pending with no plan and no session; email verification starts the trial; access is decided by `computeEntitlement`. The June pay-at-signup flow described in older sections is gone.

### Three company states (derivable from existing columns)

> **Superseded for access control (2026-07-30).** These three states are still the
> _admin-facing account_ states (and still drive the admin badge), but they no longer
> decide what a company may do. Entitlement is `computeEntitlement(company, now)` —
> see the entitlement additions above and the 2026-07-30 decision-log entry.
> In particular `is_active` now means "currently entitled to operate", and
> `companyMiddleware` blocks only the `deactivated` state.

| State       | `is_active` | `deactivated_at` | Set by                                     |
| ----------- | ----------- | ---------------- | ------------------------------------------ |
| Pending     | `false`     | `null`           | Registration                               |
| Active      | `true`      | (cleared)        | Admin activate (or future payment webhook) |
| Deactivated | `false`     | `NOT NULL`       | Admin deactivate                           |

No schema change needed to distinguish these; the admin list endpoint returns both fields.

## Entities

### `users`

Auth record for all roles.

- `id` uuid PK
- `email` varchar(255) — unique (soft-delete-aware)
- `username` varchar(64) nullable — unique when not null
- `password` varchar(255) — `select: false`, bcrypt hash
- `user_type` varchar(32) — CHECK in ('super_admin', 'company')
- `is_active` boolean default true
- `email_verified_at`, `last_login_at`, `password_changed_at` nullable timestamps
- Soft delete via `deleted_at`

### `companies`

1:1 with users (owner). Business profile.

- FK `owner_user_id` → `users.id` (unique via `@OneToOne`, RESTRICT)
- `name`, `registration_number` (unique), `contact_email`, `contact_phone` (E.164), `whatsapp_number` nullable
- **Structured address** (replaced single `address` column on 2026-05-03):
  - `street_address` text NOT NULL
  - `city` varchar(128) NOT NULL
  - `state` varchar(128) NOT NULL
  - `country` varchar(128) NOT NULL (full country name, e.g. "Niger")
  - `postal_code` varchar(32) nullable (Niger and several West African markets don't use them)
- `business_type` — CHECK in ('fuel_station', 'shop')
- `qr_token` varchar(64) unique, NOT NULL — crypto-random 24-byte base64url, generated at registration, printed on signage
- `promo_email_opt_in` (bool, default false), `terms_accepted_at` (NOT NULL)
- `is_active` (default true), `joined_at` (NOT NULL — set automatically on registration; replaces former `activated_at`)
- Deactivation audit: `deactivated_at` (nullable), `deactivated_by` (relation → users, SET NULL)
- No `activated_at` / `activated_by` — activation is automatic on registration, `joined_at` captures the timestamp

### `tokens` — third discriminator (migration 1785373200000)

`type` gains `email_verification` alongside `refresh` and `password_reset`. The column
is a plain `varchar(32)` with **no CHECK constraint**, so this needed no DDL on the
column itself.

New partial unique index, mirroring the password-reset one:

```
uq_tokens_active_email_verification
  UNIQUE ("user_id") WHERE type = 'email_verification' AND consumed_at IS NULL
```

At most one live verification link per user — mashing "resend" retires the previous
token rather than leaving several valid at once.

`users.email_verified_at` existed in the baseline and had never been written to. It is
now the source of truth for verification, and (from Phase 3) the trigger that starts
the free-trial clock.

### `customers`

Per-company customer record. Identity depends on business type.

- FK `company_id` → `companies.id` (**RESTRICT** — fintech audit safety; no cascade-delete of customer records)
- `mobile` varchar(20) — E.164
- `full_name` (NOT NULL), `vehicle_number` varchar(32) nullable
- Aggregates: `total_invoice_amount` numeric(14,2) default 0, `submission_count` int default 0
- `first_submission_at`, `last_submission_at` — NOT NULL (invariant: customer row exists ⟺ ≥1 purchase)

**Partial unique indexes (per business type):**

- `uq_customers_shop_mobile`: UNIQUE(`company_id`, `mobile`) WHERE `vehicle_number IS NULL` AND `deleted_at IS NULL`
- `uq_customers_fuel_mobile_vehicle`: UNIQUE(`company_id`, `mobile`, `vehicle_number`) WHERE `vehicle_number IS NOT NULL` AND `deleted_at IS NULL`

**Why partial:** shop customers identified by mobile alone; fuel station customers by mobile + vehicle (same mobile with two vehicles = two customer rows).
**Soft-delete aware:** once a customer is soft-deleted, same mobile can register again (the `deleted_at IS NULL` clause in the partial index allows it).

- Index: `(company_id, total_invoice_amount)` for top-spender queries

### `purchases`

Individual purchase records with immutable customer snapshots + forensic fields.

- FK `company_id` → `companies.id` (RESTRICT)
- FK `customer_id` → `customers.id` (RESTRICT)
- `invoice_number`, `invoice_amount` numeric(14,2)
- `full_name_snapshot`, `vehicle_number_snapshot` nullable — immutable history per spec
- `submitted_at` timestamp
- **Forensics (all nullable):** `ip_address` varchar(64), `user_agent` varchar(512), `latitude`/`longitude` numeric(9,6), `location_accuracy` numeric(10,2) (meters)
- `UNIQUE(company_id, invoice_number)` — DB-level anti-spam guardrail (same invoice can't be re-submitted for the same company)
- Indexes: `(customer_id, submitted_at DESC)`, `(company_id, submitted_at DESC)`

### `tokens`

Unified refresh + password reset storage.

- FK `user_id` → `users.id` (CASCADE — tokens are ephemeral, fine to cascade on user delete)
- `type` varchar(32) — no DB-level CHECK (TS string union enforces at compile time, per user preference)
- `token_hash` varchar(255) — unique, `select: false`, raw token never stored
- `expires_at`, `consumed_at` (nullable, for password_reset), `revoked_at` (nullable, for refresh)
- `ip_address`, `user_agent` nullable — audit context
- Partial unique: `UNIQUE(user_id) WHERE type='password_reset' AND consumed_at IS NULL` — enforces at most one active reset per user
- After migration generation: verify the partial-index `WHERE` clause made it into SQL

## Key Invariants

### Authentication model

- Single `users` table holds auth for all roles.
- `users.user_type` is a `varchar(32)` column with CHECK constraint `IN ('super_admin', 'company')` — no separate lookup table.
- `companies` is a 1:1 profile table linked via `owner_user_id` (unique FK to users).
- One login endpoint, one password reset flow, one JWT issuance path — differentiated by `user_type` after auth.
- Future roles (staff/operators) added as new `user_type` + new profile table.

### Customer identity

- Customer is uniquely identified by `(company_id, mobile)` — same phone across different companies = different customer rows.
- On every purchase submission, `customers.full_name` and `customers.vehicle_number` are **overwritten with the latest submitted values** (Option B).
- `purchases` table keeps an immutable snapshot of `full_name` and `vehicle_number` per row, so historical truth is always reconstructable even if the customer row is overwritten with a typo.

### Purchase integrity

- `UNIQUE(company_id, invoice_number)` enforced at DB level — blocks duplicate invoice submissions per company.
- Every purchase insert + customer upsert + aggregate update happens inside a single DB transaction with `FOR UPDATE` row lock on the customer row.
- Customer aggregates (`total_invoice_amount`, `submission_count`, `last_submission_at`) updated via SQL expressions (`col = col + ?`), never read-modify-write in app code.

### Monetary

- All monetary values stored as `numeric(14, 2)`. Never float.
- TypeORM returns `numeric` as `string` — use SQL expressions (`col = col + $1`) or decimal.js for arithmetic. Never `Number(amount)`.
- Phone numbers stored in E.164 format.

### Tokens (unified table)

- Single `tokens` table holds both refresh tokens and password reset tokens, discriminated by `type` ('refresh' | 'password_reset').
- `token_hash` stored — raw tokens NEVER persisted.
- Partial unique index: `UNIQUE(user_id) WHERE type = 'password_reset' AND consumed_at IS NULL` — enforces at most one active reset per user.
- Repository layer exposes type-specific methods only (`findActiveRefreshToken`, `findUsablePasswordResetToken`) — no generic `findByHash`.
- `refresh` tokens use `revoked_at` (logout/security); `password_reset` tokens use `consumed_at` (single-use).
- TTL: refresh 7d, password_reset 15min.

## Pending / Deferred

- QR strategy: **resolved** — static per-company `qr_token` on `companies`. No separate QR table needed.
- `report_jobs` table — to be re-introduced in Phase 4 (dashboards) for async PDF report status tracking via BullMQ.

## Implementation notes

- Transaction pattern: all repositories accept an optional `manager?: EntityManager` on every method (reads + writes). Services can compose operations inside a single transaction via `AppDataSource.transaction(run)`; `run(manager)` passes `manager` through.
- Global error handler catches Postgres `QueryFailedError` code 23505 (unique violation) and converts to a 409 RESOURCE_CONFLICT response — belt-and-suspenders beyond service-level pre-checks.
- `deleted_at IS NULL` filtering is implicit via TypeORM soft-delete semantics on all reads.

## `trial_identities`

The ledger of identifiers that have already consumed their one free trial. See
decisions.md (2026-08-04) for the rationale behind each choice below.

| Column              | Type                         | Notes                                                                                |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| id                  | uuid PK `gen_random_uuid()`  |                                                                                      |
| identifier_type     | varchar(16) NOT NULL         | CHECK `chk_trial_identities_type` — `email` \| `phone`                               |
| identifier_hash     | varchar(64) NOT NULL         | Hex HMAC-SHA256 of the canonicalised value under `TRIAL_IDENTITY_PEPPER`             |
| identifier_preview  | varchar(64) NOT NULL         | Masked (`j••••h@gmail.com`) so support can answer "why was I refused?"               |
| company_id          | uuid NULL                    | FK → companies, **ON DELETE SET NULL**                                               |
| claimed_at          | timestamptz NOT NULL `now()` |                                                                                      |
| released_at         | timestamptz NULL             | Admin hand-back. Frees the slot in the partial unique index                          |
| released_by_user_id | uuid NULL                    | FK → users, ON DELETE SET NULL                                                       |
| release_reason      | varchar(255) NULL            | CHECK `chk_trial_identities_release_reason` — required whenever `released_at` is set |

Indexes: partial UNIQUE `uq_trial_identities_active` on `(identifier_hash) WHERE released_at IS NULL`;
partial `idx_trial_identities_company` on `(company_id) WHERE company_id IS NOT NULL`.

**This table deliberately has no `deleted_at` and its entity does NOT extend `BaseEntity`.**
TypeORM excludes soft-deleted rows from `find`, so a soft-deleted row would vanish from
every eligibility check while still holding its slot in the unique index — the registry
would quietly stop blocking and nothing would look wrong.

**`company_id` is ON DELETE SET NULL, never CASCADE.** CASCADE here would mean "delete
your account, get another free trial".

**The unique index is partial on purpose.** It is what makes an admin release actually
free the identifier, and it is what
`INSERT ... ON CONFLICT ("identifier_hash") WHERE "released_at" IS NULL DO NOTHING`
infers against. A plain UNIQUE would make a release impossible without destroying the
audit trail.

Claims use `ON CONFLICT ... DO NOTHING RETURNING id` rather than catching a 23505:
registration and verification both run inside a transaction, and an unhandled unique
violation aborts the _whole_ transaction in Postgres — which would block the signup
itself, violating the rule that a repeat identifier costs you the trial and nothing else.

## `bulk_email_logs`

Record of every admin broadcast. An action that reaches every customer on the platform
should not be reconstructable only from mail-server logs.

| Column             | Type            | Notes                                                     |
| ------------------ | --------------- | --------------------------------------------------------- |
| `id`               | uuid PK         |                                                           |
| `subject`          | varchar(255)    |                                                           |
| `body`             | text            | Stored raw, escaped at render time                        |
| `sent_by_user_id`  | uuid FK → users | `ON DELETE SET NULL` — the record outlives the admin      |
| `sent_by_email`    | varchar(255)    | Denormalised, so the log still reads correctly after that |
| `recipient_count`  | int             | What was actually queued, not what was requested          |
| `recipient_ids`    | jsonb           | Company ids                                               |
| `extra_recipients` | jsonb           | Addresses not attached to any company                     |
| `sent_at`          | timestamptz     | Indexed DESC                                              |

Extends `BaseEntity`.

## Expiry / retention columns on `companies`

| Column                           | Purpose                                           |
| -------------------------------- | ------------------------------------------------- |
| `trial_ending_notice_for`        | Trial warning, 48h out                            |
| `subscription_ending_notice_for` | **Paid** plan warning, 24h out                    |
| `trial_ended_notice_for`         | Trial lapsed                                      |
| `subscription_ended_notice_for`  | Paid plan lapsed                                  |
| `data_purged_at`                 | When a lapsed company's collected data was erased |

Each `*_notice_for` stores **the deadline the notice was sent for**, not a boolean.
That is what lets an extended trial be warned again: the marker no longer equals the
new `trial_ends_at`, so the claim query (`IS DISTINCT FROM`) picks it up. A boolean
would silence every extended trial permanently.

`data_purged_at` is distinct from `anonymized_at`. A company that stopped paying has
not left — its account, login and payment history survive so it can return. Only the
customers and purchases it collected are erased.
