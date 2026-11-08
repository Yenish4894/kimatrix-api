# Security rules

Every rule here is already enforced somewhere in `src/`. New code keeps them; a change to one is a decision for `decisions.md`.

## Request handling

- `app.ts` applies `helmet()`, explicit-origin CORS from `FRONTEND_BASE_URL`, and `globalApiLimiter` before any route. Never add a wildcard origin.
- Every body/query/param is validated with Joi through `validateRequest()` (`src/middleware/validation.ts`) with `stripUnknown: true` and `abortEarly: false`. Field names may be logged; values never.
- Every string in a schema has a maximum length (`commonPatterns` in `validation/schemas/common.schema.ts`).
- Multipart uploads go through `attachmentUpload` (`middleware/attachmentUpload.ts`): 10 MB cap, allow-listed types, stored under `ATTACHMENT_DIR`, cleaned by `AttachmentCleanupService`.

## Auth

- `authMiddleware` verifies the access JWT; `companyMiddleware` and `superAdminMiddleware` check `user.userType`. Route-level checks are repeated in services for anything that mutates money or access.
- Refresh tokens rotate; reuse of a rotated token revokes the whole family (`TokenService`, `tokens` table).
- Login, register, password reset, email change and QR submit each have their own limiter in `middleware/rateLimit.ts`. Auth limiters are keyed per identifier and fail closed.
- Login returns the same `401 Invalid credentials` for unknown user, inactive user and wrong password. Company-state messages appear only after the password is verified.
- Password policy: 8 to 18 characters with upper, lower, digit and special. Hashes are `select: false` and redacted by pino.
- Registration carries a honeypot (`rejectHoneypot`) and Cloudflare Turnstile (`requireTurnstile`), both in `middleware/botProtection.ts`. Turnstile is skipped only when `TURNSTILE_SECRET_KEY` is unset.
- Forgot-password and resend-verification always answer the same way whether or not the account exists.

## Access control

- `computeEntitlement()` runs on every protected request. Priority: ban > comp > paid > trial. A ban is lifted only by an admin; verification and payment never lift it.
- `requireActiveSubscription` gates paid features; `requireExportAllowed` lets a lapsed company still export and reach billing.
- Admin destructive actions (ban, comp, trial extend, delete) require a reason and write an audit row in the same transaction.

## Data

- Secrets come from `src/config/index.ts`, which throws at boot when a required variable is missing. No fallback defaults for secrets.
- Trial abuse: emails are canonicalised (dots and plus-tags stripped for Gmail) and hashed with `TRIAL_IDENTITY_PEPPER` into `trial_identities`; one trial per email and per phone, ever.
- Invoice numbers are unique per company; QR submissions have per-minute, per-day and per-address limits plus a resubmit cooldown.
- The global per-IP cap (100 per 15 min) skips `/api/qr/*` and the PayPal webhook (`isGlobalLimitExemptPath` in `utils/rateLimitBypass.ts`). QR customers often share one address (carrier NAT, shop Wi-Fi), so those routes use their own limits: `qrResolveLimiter` (300 per 15 min per address and QR code) and a per-address submit cap of 200 a day per QR code (raised from 30 on 2026-11-08).
- Bulk email: 5 sends per admin per hour (`bulkEmailLimiter`, `skipFailedRequests: true`), only to opted-in companies, every send logged in `bulk_email_logs`.
- PayPal webhooks are signature-verified against `PAYPAL_WEBHOOK_ID` and recorded in `paypal_webhook_events` before processing (idempotent).
- Logs never contain emails, phone numbers, tokens or payloads. Log ids and domains.

## Checklist for new endpoints

- [ ] Joi schema with max lengths, wired with `validateRequest`
- [ ] Correct auth middleware chain, plus service-level re-check if it changes money or access
- [ ] Rate limiter if public or credential-related
- [ ] Audit row for admin or access-changing actions
- [ ] Transaction around multi-write operations
- [ ] Added to `.claude/rules/endpoints.md`
