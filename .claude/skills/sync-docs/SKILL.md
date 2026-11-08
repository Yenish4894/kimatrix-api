---
name: sync-docs
description: Use after changing backend code to find which files under .claude/rules or CLAUDE.md must be updated so the project docs stay true. Maps each kind of change to its document.
---

# Keep the docs in sync

Run `git diff --name-only` and map every changed file with this table. Edit the doc in the same commit as the code.

| Changed                                                                                                                                            | Update                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/entities/*`, `migrations/*`                                                                                                                   | `.claude/rules/schema.md` (entity, invariants, migration count); `CLAUDE.md` structure line if a new folder appeared |
| `src/routes/*`, controller handlers                                                                                                                | `.claude/rules/endpoints.md` (route, auth chain, request and response shape)                                         |
| A multi-step behaviour (service orchestration, cron, webhook)                                                                                      | `.claude/rules/flows.md`                                                                                             |
| A choice between alternatives, or a reversal of an earlier one                                                                                     | `.claude/rules/decisions.md` (date, decision, why, alternatives, revisit trigger)                                    |
| `middleware/auth.ts`, `rateLimit.ts`, `botProtection.ts`, `validation.ts`, anything about secrets or logging                                       | `.claude/rules/security.md`                                                                                          |
| `PaymentService`, `PaypalService`, `PaypalWebhookService`, `SubscriptionService`, `PlanService`, `config/retention.ts`, purge or deletion services | `.claude/rules/payments-paypal.md`                                                                                   |
| `LuckyDrawService`, `LuckyDrawRepository`, `AdminCompService`                                                                                      | `.claude/rules/lucky-draw.md`                                                                                        |
| `.github/workflows/*`, server, nginx, pm2, backups, monitoring                                                                                     | `.claude/rules/infrastructure.md`                                                                                    |
| New cron, queue or worker                                                                                                                          | `CLAUDE.md` background jobs table                                                                                    |
| New npm script                                                                                                                                     | `CLAUDE.md` commands block                                                                                           |
| A lesson learned the hard way                                                                                                                      | `CLAUDE.md` gotchas (one line) and the detailed rule file                                                            |

## How

1. List the changed files.
2. For each row that matches, open the doc and make a surgical edit: change the line that is now wrong, add the line that is now missing. No rewrites, no duplication between files.
3. Keep `CLAUDE.md` under 150 lines; move detail into a rule file instead.
4. Run the `doc-standards` checklist.

## Checklist

- [ ] Every changed route is in `endpoints.md` with its auth chain
- [ ] Every changed entity is in `schema.md`
- [ ] Any new rule has a dated entry in `decisions.md`
- [ ] No code example in a doc references a function that no longer exists
- [ ] `wc -l CLAUDE.md` under 150
