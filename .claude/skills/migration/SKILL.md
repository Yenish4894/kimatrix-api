---
name: migration
description: Use when writing, reviewing or running a TypeORM migration in this repo. Deploys run migrations on the live database automatically, so this covers safety rules, naming, backfills and how to test against a copy first.
---

# Migrations

**A push to `main` runs `npm run migration:run` against the production database before the app restarts.** Treat every migration as live the moment it is pushed.

## Writing one

1. Change the entity, then `npm run migration:generate -- migrations/<CamelCaseName>`. The file is `migrations/<timestamp>-<camelCaseName>.ts` with a class `<Name><timestamp>`.
2. Read the generated SQL line by line. TypeORM over-generates (type churn, index renames). Remove anything you did not intend.
3. Make it additive and re-runnable: `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`.
4. Write a real `down()`. The deploy does not use it, but `npm run migration:revert` does.
5. New NOT NULL columns get a default or a backfill statement first. Backfills that touch many rows run in the same migration only when the table is small (all tables here are, today); state the assumption in a comment.
6. Partial unique indexes, CHECK constraints and enum additions are declared here, not only in the entity. Example: `uq_lucky_draws_one_win_per_base_period` in `1787284800000-boughtSpinPools.ts`.

## Never

- Drop or rename a column the running release still reads. Add the new column, deploy code that writes both, then remove in a later migration.
- Edit a migration that has already been applied anywhere. Write a new one.
- Put data fixes for one customer into a migration. Use a one-off script in `scripts/` or a guarded SQL run with a backup.

## Testing before push

- `npm run migration:show` to confirm ordering.
- Against a copy of production: `pg_dump -Fc qr_scan | pg_restore -d qr_scan_migcheck`, point `DB_NAME` at it, run `migration:run` and `migration:revert`, then drop the copy. The nightly dumps are in `/var/backups/qr_scan/` on the server.
- `EXPLAIN` any new query that the migration's indexes are meant to serve.

## After it lands

- Update `.claude/rules/schema.md` (entity, invariants, migration count).
- If the change encodes a decision, add it to `.claude/rules/decisions.md` with the date.
- Verify on the server: `sudo -u postgres psql -d qr_scan -c "select name from migrations order by id desc limit 3"`.
