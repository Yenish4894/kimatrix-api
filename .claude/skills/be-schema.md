---
name: be-schema
description: Living reference of the sena-temp backend database schema — entities, relationships, and key invariants. Update after every migration.
---

# sena-temp Backend Schema

> Update this file whenever an entity is added, modified, or removed. Keep in sync with `src/entities/` and `migrations/`.

## Status

v2 schema implemented. 7 entities in `src/entities/`. PayPal payments + subscription window live.

## Conventions

- All tables use **UUID** primary keys (`uuid_generate_v4()`)
- DB columns are `snake_case`, TS properties are `camelCase`. `name:` in `@Column` only when they differ.
- Timestamps: `created_at`, `updated_at`, `deleted_at` (soft delete) on every table via `BaseEntity`. All `timestamptz`.
- Foreign keys: explicit `@JoinColumn({ name: "snake_case_id" })`. No explicit FK columns on entities — relation property only (access via `entity.relation.id`).
- Monetary amounts: stored as `numeric(14, 2)` — never float. Returned as `string` by TypeORM; use SQL expressions for arithmetic.
- Phone numbers: stored in E.164 format (`+227XXXXXXXX`), varchar(20).
- Enums: stored as `varchar` + TypeScript string-literal unions from `as const` arrays + `@Check` constraints (not PG enums — avoids migration friction).
- No `readonly` on class members per user preference.

## Scope (v2)

7 tables total:

| #   | Table       | Purpose                                                                         |
| --- | ----------- | ------------------------------------------------------------------------------- |
| 1   | `users`     | Auth record for all roles; `user_type` column with CHECK constraint             |
| 2   | `companies` | Company profile (1:1 with users via `owner_user_id`); holds subscription window |
| 3   | `customers` | Per-company customer records                                                    |
| 4   | `purchases` | Purchase submissions, enforces invoice uniqueness                               |
| 5   | `tokens`    | Unified refresh + password reset tokens                                         |
| 6   | `plans`     | Subscription plans (seeded: 7/15/21/30 day in ZAR)                              |
| 7   | `payments`  | PayPal payment records; one row per order attempt                               |

### `plans` table

| Column        | Type          | Notes                                |
| ------------- | ------------- | ------------------------------------ |
| id            | uuid PK       |                                      |
| name          | varchar(100)  | e.g. "30 Day Plan"                   |
| duration_days | int           |                                      |
| price         | decimal(10,2) |                                      |
| currency      | varchar(3)    | "ZAR"                                |
| is_active     | boolean       | soft-disable a plan without deleting |

### `payments` table

| Column                 | Type                 | Notes                                      |
| ---------------------- | -------------------- | ------------------------------------------ |
| id                     | uuid PK              |                                            |
| company_id             | uuid FK → companies  | ON DELETE RESTRICT                         |
| plan_id                | uuid FK → plans      | ON DELETE RESTRICT                         |
| paypal_order_id        | varchar(64) UNIQUE   | PayPal's order ID                          |
| status                 | varchar(20)          | pending \| captured \| failed \| cancelled |
| amount                 | decimal(10,2)        | snapshot of plan price at time of purchase |
| currency               | varchar(3)           | snapshot of plan currency                  |
| captured_at            | timestamptz nullable | when PayPal capture completed              |
| subscription_starts_at | timestamptz nullable | start of subscription window               |
| subscription_ends_at   | timestamptz nullable | end of subscription window                 |
| paypal_response        | jsonb nullable       | full PayPal API response (audit trail)     |

### `companies` additions (migration 1748100000000)

| Column                  | Type                     | Notes                                   |
| ----------------------- | ------------------------ | --------------------------------------- |
| current_plan_id         | uuid FK → plans nullable | last plan purchased                     |
| subscription_expires_at | timestamptz nullable     | null = never subscribed; past = expired |

## Deferred (design kept compatible)

- Expiry-reminder cron, auto-PDF-email on expiry — deferred.
- QR strategy (permanent vs per-transaction) — pending decision; isolated so it's additive.
- Centralized `audit_logs`, `email_logs`, `bulk_email_campaigns`, `report_jobs` — not needed for v1; sufficient coverage via scattered who/when fields + BullMQ job history.

## Adaptability anchors

- `companies.is_active` + `companies.joined_at` + `companies.deactivated_at/by` cover v1 activation state. When payments ship, add `subscriptions` table; activation gate becomes `is_active AND has_active_subscription()`.
- Service-layer seam: consumers call `CompanyService.getActivationStatus(companyId)` (to be built) instead of reading `company.is_active` directly — returns `{ active, reason?, expiresAt? }`. Today returns only `active`; future returns subscription window with no caller changes.
- PDF reports are planned as on-demand API endpoints in v1. Future expiry cron is a thin scheduler over the same report-generation service.
- Registration flow: **registers as pending** (`is_active=false`, `joined_at=now()`, no tokens). Super admin activates manually (typically after payment verification). When payments ship, the activation trigger flips from manual admin action to payment-webhook callback — same `setActivated` repo method, different caller.

### Three company states (derivable from existing columns)

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
