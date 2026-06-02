---
name: be-scaffold
description: Checklist for scaffolding a new backend feature (entity → repository → service → controller → route → validation → migration). Use when adding any new resource.
---

# sena-temp Backend Feature Scaffold Checklist

When adding a new feature/resource, create these files in order:

## 1. Entity — `src/entities/<Name>.ts`

- Extend `BaseEntity` (id, createdAt, updatedAt, deletedAt)
- Use `@Entity("snake_case_plural")`
- Explicit `@JoinColumn({ name: "snake_case_id" })` on FKs
- `select: false` on password/token fields
- Monetary: `numeric(12, 2)`
- Phone: E.164 `varchar(20)`

## 2. Migration — `migrations/<timestamp>-<Name>.ts`

- Generate: `npm run migration:generate -- migrations/<Name>`
- Review generated SQL — do NOT auto-apply without reading
- Add unique constraints, indexes, check constraints as needed
- Never `ALTER TABLE ... DROP` in a migration that's already run in production

## 3. Repository — `src/repositories/<Name>Repository.ts`

- Wrap `AppDataSource.getRepository(Entity)` in constructor
- Methods: `create`, `getById`, `findAll(filters, pagination)`, `update`, `softDelete`
- Use QueryBuilder for complex filters — never string concatenation
- Paginated results: `.getManyAndCount()`

## 4. Service — `src/services/<Name>Service.ts`

- Instantiate repository in constructor
- All business logic lives here (validation, orchestration, transformations)
- Wrap operations in try/catch + logger
- Use DB transactions for multi-write operations: `AppDataSource.transaction(...)`
- Throw `AppError`s — never return error objects

## 5. Validation Schema — `src/validation/schemas/<name>.schema.ts`

- Use `commonPatterns` from `common.schema.ts`
- `.strict()` on all object schemas — reject unknown fields
- Separate schemas: create, update, query params, route params

## 6. Controller — `src/controllers/<Name>Controller.ts`

- Extend `BaseController`
- Instantiate service in constructor
- Wrap every handler in `this.handleAsync(...)`
- Sanitize response data before returning
- Use `createPaginationResponse` for list endpoints

## 7. Route — `src/routes/<name>.route.ts`

- Middleware order: auth → validation → handler
- Register in `src/routes/index.ts`

## 8. Update Living Docs

- Add entity to `.claude/skills/be-schema.md`
- Add flow (if new) to `.claude/skills/be-flows.md`

## Security Checklist (every feature)

- [ ] No secrets or PII logged
- [ ] All user input validated before touching DB
- [ ] All money-touching operations inside a DB transaction
- [ ] Audit log written for create/update/delete of sensitive resources
- [ ] Rate limiting considered on public-facing endpoints
- [ ] Authz checks at route level AND re-verified at service level
