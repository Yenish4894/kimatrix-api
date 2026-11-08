# sena-temp backend (kimatrix-api)

Express + TypeScript (ESM) API for KIMates: businesses get a QR code, their customers log purchases through it, and the platform owner runs everything from an admin panel. Working name in conversation: **sena-temp**. Brand in user-facing copy: **KIMates**.

## Tech stack

- Node 22, Express 4, TypeScript 5.9 (ES2022, ESM, strict), path alias `@/` → `src/`
- PostgreSQL 18 + TypeORM 0.3 (`synchronize: false`, migrations only, 27 so far)
- Validation: Joi. Logging: pino (`req.id`, redaction). Auth: JWT access + rotating refresh, bcrypt
- Redis 7: BullMQ email queue, express-rate-limit store, SMTP health keys
- node-cron jobs, each guarded by a Postgres advisory lock (`AdvisoryLockRepository`)
- PayPal: Orders API (plans, spin add-ons) and Subscriptions API (auto-renew, **switched off for users since 2026-09-27**)
- Email: Nodemailer over SMTP through Resend. PDFs: jsPDF (`src/pdf/`)
- Tests: `node:test` via `tsx` (44 files, colocated `*.test.ts`)

## Commands

```bash
npm run dev            # tsx watch src/server.ts  (PORT 5000 locally, 9420 in production)
npm run build          # tsc + tsc-alias + tsc-esm-fix → dist/
npm test               # all *.test.ts
npm run lint | lint:fix | format | typecheck
npm run migration:generate -- migrations/<Name>   # review the SQL before committing
npm run migration:run | migration:revert | migration:show
```

## Structure

```
src/
  server.ts            boot: DB, email worker, 7 crons, graceful shutdown
  app.ts               helmet, cors, pino-http, limiters, /api routes, errorHandler
  routes/              auth company admin qr payment metrics (+ routeGuards.test)
  controllers/         extend BaseController: handle(), sendSuccess(), paginationResponse()
  services/            business logic; one class per domain
  repositories/        TypeORM + raw parameterised SQL; no logic
  entities/            14 entities, all extend BaseEntity (uuid, timestamps, deletedAt)
  middleware/          auth, validation, rateLimit, subscription, botProtection, attachmentUpload, bulkEmailLimit
  validation/schemas/  Joi: common, auth, company, admin, payment, qr
  cron/ queues/ workers/ pdf/ templates/ config/ utils/
migrations/            <timestamp>-<name>.ts
data-source.ts
```

## Conventions

- **Layering**: route → controller → service → repository. Controllers never touch TypeORM; repositories never throw `AppError`.
- **Errors**: throw the factories in `src/middleware/errorHandler.ts` (`BadRequestError`, `NotFoundError`, `ConflictError`, `ValidationError`, `SubscriptionRequiredError`...). The global handler formats `{ success:false, error, message, requestId }`.
- **Validation**: `validateRequest(schema, ValidationTarget.X)`; schemas use `commonPatterns` and `stripUnknown`. Failing field names are logged, values never are.
- **Auth middleware**: `authMiddleware` → `companyMiddleware` / `superAdminMiddleware`; paid features add `requireActiveSubscription`. Access is computed per request by `computeEntitlement()` (`src/utils/entitlement.ts`): ban > comp > paid > trial.
- **Money**: `numeric(12,2)`. Payments to KIMates are USD; customer amounts use the company country's currency and are never summed across currencies.
- **Audit**: anything an admin does to a company, and anything that changes access, goes through `AuditService.record()` inside the same transaction.
- **Soft delete** via `deletedAt` for users/companies; hard erasure only through the retention purge.
- **Style**: Prettier (double quotes, width 100, trailing commas). Husky + lint-staged run on commit. Comments explain _why_; match the surrounding density.

## Gotchas

- **A push to `main` deploys and runs migrations against the live database.** Commit freely, push only when asked. Migrations must be additive and re-runnable; never drop a column a running release still reads.
- Bought spins live in their own `buy:<key>` pool (`LuckyDrawRepository`); never fold them into the free count or a trial-spin change eats paid spins. See `.claude/rules/lucky-draw.md`.
- `freeDrawPeriodOpen` is the capture-time check for spin purchases on trial/comp; refuse captures only on an exact period-key mismatch.
- PayPal refuses to cancel `APPROVAL_PENDING` subscriptions (404); de-duplicate on the receive side instead.
- SMTP `From` must equal the SMTP user, or the provider silently drops every email.
- Do not run `scripts/sync-paypal-plans.ts` while auto-renew is off.
- `lint-staged` runs Prettier here. Do not run Prettier on the frontend repo.
- Bash heredocs mangle backslashes; write regex-heavy edits through a script file.

## Domain index

Detail lives in the linked file; do not duplicate it here.

- Schema, entities, invariants → `.claude/rules/schema.md`
- Endpoint registry (routes, auth, shapes) → `.claude/rules/endpoints.md`
- Business flows step by step → `.claude/rules/flows.md`
- Decision log and open questions → `.claude/rules/decisions.md`
- Security rules → `.claude/rules/security.md`
- PayPal, plans, subscriptions, refunds, retention → `.claude/rules/payments-paypal.md`
- Lucky draw pools and purchases → `.claude/rules/lucky-draw.md`
- Server, deploy, backups, monitoring → `.claude/rules/infrastructure.md`
- Skills: `new-feature`, `migration`, `commit-check`, `sync-docs`, `doc-standards`

## Background jobs (`src/server.ts`)

| Cron               | Schedule (UTC)        | Does                                               |
| ------------------ | --------------------- | -------------------------------------------------- |
| tokenCleanup       | `0 3 * * *`           | purge expired tokens                               |
| subscriptionStatus | `5 * * * *`           | expiry notices, status flips                       |
| smtpCanary         | `17 * * * *`          | test send, SMTP health keys                        |
| paymentReconcile   | `*/10` + `20 3 * * *` | stuck captures; subscriptions vs PayPal            |
| accountDeletion    | `20 3 * * *`          | erase after 7-day grace                            |
| expiredDataPurge   | `20 3 * * *`          | erase 7 days after expiry (`EXPIRY_PURGE_ENABLED`) |
| unverifiedCleanup  | `40 3 * * *`          | delete never-verified signups                      |

Email worker: BullMQ queue `email` (`src/queues/email.queue.ts`, `src/workers/email.worker.ts`).

## Mandatory verification

`npm run lint`, `npm run typecheck` and `npm test` must all pass before work is called done. Show the output. After schema or route changes, run the `sync-docs` skill.
