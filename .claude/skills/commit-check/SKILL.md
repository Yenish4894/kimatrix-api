---
name: commit-check
description: Use before every git commit in this repo. Runs the gate (lint, typecheck, tests), checks that changed code has tests and that the docs under .claude were updated, then commits. Never pushes.
---

# Commit check (backend)

Run this before committing. Do not commit until every step is green, and show the command output rather than asserting it.

## 1. The gate

```bash
npm run lint
npm run typecheck
npm test
```

lint-staged runs Prettier and ESLint on staged files at commit time through Husky; that is a formatter, not a substitute for the three commands above.

A failing test means fix the code if it is a real regression. Edit the test only when the test is wrong. Never delete or skip a test to go green.

## 2. Tests for what changed

For each changed service, repository, middleware or schema file without a colocated `*.test.ts`, add one covering the new behaviour and its edges (not found, forbidden, conflict, soft-deleted, boundary values). Follow the stubbing style in `src/services/adminComp.test.ts` and `src/routes/routeGuards.test.ts`.

## 3. Docs

Run the `sync-docs` skill. Changed entities, routes, flows or decisions must be reflected in `.claude/rules/` in the same commit.

## 4. Commit

- Conventional prefix with scope: `fix(bulk-email): ...`, `feat(lucky-draw): ...`, `chore(deps): ...`.
- Body says why, not what. Reference the user-visible symptom when fixing a bug.
- Commit only. **Pushing deploys to production and runs migrations**; push only when the owner asks.

## 5. Report

State what changed, what was skipped and why, and the exact commands that passed.
