# sena-temp Backend

## Living context files (read first)

- [.claude/skills/be-schema.md](.claude/skills/be-schema.md) — current DB schema, entities, invariants
- [.claude/skills/be-flows.md](.claude/skills/be-flows.md) — documented business flows
- [.claude/skills/be-endpoints.md](.claude/skills/be-endpoints.md) — API endpoint registry
- [.claude/skills/be-decisions.md](.claude/skills/be-decisions.md) — decision log with rationale
- [.claude/skills/be-scaffold.md](.claude/skills/be-scaffold.md) — feature-scaffold checklist

**Keep these up to date alongside every change** — schema edit → update be-schema.md, new endpoint → update be-endpoints.md, locked-in decision → add to be-decisions.md, new/changed flow → update be-flows.md.

## Architecture

Repository -> Service -> Controller layering. Strict separation of concerns:

- **Repository** = data access only (TypeORM queries, CRUD)
- **Service** = business logic (validation, orchestration, transformations)
- **Controller** = HTTP concerns only (parse request, call service, format response)
- **Middleware** = cross-cutting concerns (auth, validation, rate limiting)

## Tech Stack

| Layer      | Technology                              |
| ---------- | --------------------------------------- |
| Runtime    | Node.js >= 22, TypeScript ES2022, ESM   |
| Framework  | Express 4.x                             |
| Database   | PostgreSQL + TypeORM 0.3.x              |
| Validation | Joi                                     |
| Auth       | JWT (access + refresh tokens), bcryptjs |
| Email      | SendGrid                                |
| Queue      | BullMQ + Redis (ioredis)                |
| Cron       | node-cron                               |
| Security   | Helmet, CORS, express-rate-limit        |
| Payments   | Flutterwave                             |
| PDF        | TBD                                     |
| Dev        | tsx watch                               |
| Build      | tsc + tsc-alias + tsc-esm-fix           |

## Path Alias

`@/` maps to `src/`. All imports use `@/entities/User`, `@/services/AuthService`, etc.

## Folder Structure

```
backend/
├── src/
│   ├── server.ts              # Entry point: DB init, cron, workers, graceful shutdown
│   ├── app.ts                 # Express config: middleware, routes, error handler
│   ├── config/
│   │   ├── index.ts           # Env vars, validation, typed config
│   │   └── redis.config.ts    # BullMQ Redis connection
│   ├── entities/              # TypeORM entities (1 file per table)
│   │   └── BaseEntity.ts     # Abstract: id (uuid), createdAt, updatedAt, deletedAt
│   ├── repositories/          # Data access layer
│   ├── services/              # Business logic layer
│   ├── controllers/
│   │   └── BaseController.ts  # sendSuccess, sendError, handleAsync, pagination
│   ├── routes/
│   │   └── index.ts           # Route aggregation
│   ├── middleware/
│   │   ├── errorHandler.ts    # AppError class + factory functions + global handler
│   │   ├── auth.ts            # JWT auth middleware variants
│   │   └── validation.ts      # Joi validation middleware
│   ├── validation/schemas/    # Joi schemas (common patterns + feature schemas)
│   ├── errors/index.ts        # Re-exports from errorHandler
│   ├── queues/                # BullMQ job queues
│   ├── workers/               # BullMQ workers
│   ├── cron/                  # node-cron scheduled tasks
│   ├── utils/
│   │   └── logger.ts          # Custom logger (ERROR, WARN, INFO, DEBUG)
│   ├── constants/             # App-wide constants
│   └── types/                 # TypeScript types/interfaces
├── migrations/                # TypeORM migrations
├── data-source.ts             # TypeORM DataSource config
├── package.json
├── tsconfig.json
└── .env
```

## Code Patterns

### Entities

- All extend BaseEntity (uuid PK + timestamps + soft delete)
- `select: false` on password fields
- Explicit `@JoinColumn({ name: "column_name" })` on FKs
- `jsonb` for flexible structured data

### Repositories

- Wrap `AppDataSource.getRepository(Entity)` in constructor
- `create()` uses `.save(.create(data))`
- QueryBuilder for complex queries with dynamic filters/sorts
- `.getManyAndCount()` for paginated results
- `.getRawOne()` for aggregates

### Services

- Instantiate repository in constructor
- Wrap repo calls with try/catch + logger
- Throw errors upward (controller handles response)

### Controllers

- Extend BaseController
- Instantiate service in constructor
- Every method wrapped in `handleAsync()`
- Throw `NotFoundError()`, `BadRequestError()` etc.
- Sanitize data before returning
- Use `createPaginationResponse()` for list endpoints

### Routes

- One Router per feature
- Middleware order: auth -> validation -> handler
- Controller instantiated at module level

### Validation

- Joi schemas with `abortEarly: false`, `stripUnknown: true`
- Common patterns in `common.schema.ts` (email, uuid, password, etc.)
- `ValidationType` enum: BODY, QUERY, PARAMS

### Error Handling

- `AppError` class with statusCode, code, details
- Factory functions: `BadRequestError()`, `NotFoundError()`, `createUnauthorizedError()`, etc.
- Global error handler as last middleware

## API Response Shapes

```json
// Success
{ "success": true, "message": "...", "data": {}, "timestamp": "..." }

// Paginated
{ "success": true, "data": { "items": [], "pagination": { "total", "page", "limit", "totalPages" } } }

// Error
{ "success": false, "message": "...", "error": "ERROR_CODE", "timestamp": "..." }

// Validation Error
{ "success": false, "error": "VALIDATION_ERROR", "details": [{ "field": "...", "message": "..." }] }
```

## Roles (sena-temp specific)

| Role        | Description                                                         |
| ----------- | ------------------------------------------------------------------- |
| Super Admin | Platform owner - manages companies, visitor stats, bulk emails      |
| Company     | Fuel station / shop - registers, pays, gets QR, views customer data |
| Customer    | Scans QR, fills purchase form (no login required)                   |

No Casbin - simple role-based checks via auth middleware variants.
