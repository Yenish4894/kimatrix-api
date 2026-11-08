---
name: new-feature
description: Use when adding a new backend resource or endpoint group (entity → migration → repository → service → schema → controller → route → docs). Walks the sena-temp layering with the real base classes and checklists.
---

# New backend feature

Create the files in this order. Each step names the real file to copy the pattern from.

## 1. Entity: `src/entities/<Name>.ts`

- Extend `BaseEntity` (`id` uuid, `createdAt`, `updatedAt`, `deletedAt`). `@Entity("snake_case_plural")`.
- Explicit `@JoinColumn({ name: "snake_case_id" })` on relations. `select: false` on secrets.
- Money `numeric(12,2)`; phone E.164 `varchar(20)`; flexible data `jsonb`.
- Pattern: `src/entities/Payment.ts`.

## 2. Migration: `migrations/<timestamp>-<name>.ts`

Run the `migration` skill. Short version: generate, read the SQL, make it additive and re-runnable, never drop what production still reads.

## 3. Repository: `src/repositories/<Name>Repository.ts`

- Wrap `AppDataSource.getRepository(Entity)`; expose `create`, `findById`, `findAll(filters, pagination)`, `update`, `delete` (soft, via `deletedAt`).
- QueryBuilder or parameterised raw SQL for anything dynamic; never string-concatenate input.
- Accept an optional `EntityManager` on methods that services call inside a transaction.
- Pattern: `src/repositories/CompanyRepository.ts`; raw SQL pattern: `src/repositories/LuckyDrawRepository.ts`.

## 4. Service: `src/services/<Name>Service.ts`

- All rules live here. Throw `AppError` factories from `@/middleware/errorHandler`; never return error objects.
- Multi-write work runs in `AppDataSource.transaction(async (manager) => ...)`, with `AuditService.record(entry, manager)` for admin or access-changing actions.
- Cross-process guards use `AdvisoryLockRepository`.
- Pattern: `src/services/AdminCompService.ts` (small) or `src/services/PaymentService.ts` (transactions, PayPal).

## 5. Validation: `src/validation/schemas/<area>.schema.ts`

- Build from `commonPatterns` in `common.schema.ts`; every string has a max; separate create / update / query / params schemas.
- Export the TypeScript input type next to the schema (see `SendBulkEmailInput` in `admin.schema.ts`).
- Add a `<area>.schema.test.ts` case for each rejection you rely on.

## 6. Controller: `src/controllers/<Name>Controller.ts`

- Extend `BaseController`; every handler runs through `this.handle(res, async () => ...)` so thrown `AppError`s become responses.
- Read ids from `req.user` set by auth middleware, never from the body.
- Lists return `this.paginationResponse(items, total, page, limit)`; read `page`/`limit` with `this.getPagination(req.query)`.

## 7. Route: `src/routes/<area>.route.ts`

- Order: limiter (if any) → `authMiddleware` → role middleware → `requireActiveSubscription` (if paid) → `validateRequest` → handler.
- Register in `src/routes/index.ts`. Add a case to `src/routes/routeGuards.test.ts` so the guard chain is locked by a test.

## 8. Tests

`node:test` colocated `*.test.ts`, run with `npm test`. Services get unit tests with repository stubs (see `src/services/adminComp.test.ts`).

## 9. Docs (run the `sync-docs` skill)

- Entity → `.claude/rules/schema.md`
- Routes → `.claude/rules/endpoints.md`
- Multi-step behaviour → `.claude/rules/flows.md`
- A non-obvious choice → `.claude/rules/decisions.md`

## Security checklist

- [ ] Input validated before it reaches a repository
- [ ] Authz at the route and again in the service for money or access changes
- [ ] Rate limiting on anything public or credential-related
- [ ] Audit row for admin actions
- [ ] No PII, tokens or payloads in logs
- [ ] `npm run lint && npm run typecheck && npm test` green
