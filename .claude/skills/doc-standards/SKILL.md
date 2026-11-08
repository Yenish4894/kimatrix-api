---
name: doc-standards
description: Use when creating or editing CLAUDE.md, .claude/rules/*.md or .claude/skills/*/SKILL.md in this repo. The format rules that keep the instructions short, true and non-duplicated.
---

# Documentation standards

## CLAUDE.md

- Under 150 lines. It is the always-loaded entry point, so every line costs attention on every task.
- Order: one-line overview, tech stack, commands, structure, conventions, gotchas, domain index, background jobs, mandatory verification.
- Gotchas are one line each and name the file or symbol. The story behind them belongs in a rule file.
- The domain index only points. If a fact is in a rule file, CLAUDE.md does not repeat it.

## `.claude/rules/*.md`

- One file per domain. Plain markdown, no frontmatter. Always loaded, so still keep them tight: tables over prose, real symbol names, no code blocks longer than ten lines.
- Each file starts with the key files it describes.
- Dated statements ("since 2026-09-27", "last verified 2026-11-08") so staleness is visible.
- `schema.md`, `endpoints.md`, `flows.md` and `decisions.md` are registries: append or correct, never rewrite history. Decisions that are reversed get a new dated entry pointing at the old one.

## `.claude/skills/<name>/SKILL.md`

- Frontmatter with `name` and a `description` that says **when** to use it (the trigger), not what it contains.
- One workflow or one pattern per skill. Steps reference real files to copy from.
- Ends with a checklist.

## Everything

- English, plain words, no em dashes. Working name `sena-temp` in docs; `KIMates` only in user-facing copy.
- No secrets, hostnames with credentials, or personal data. Point at `CREDENTIALS.md` (outside the repo) instead.
- Code references as `path/to/file.ts` or `` `Symbol` `` so they are searchable.
- Remove a line when it stops being true. Stale instructions are worse than none.

## Checklist

- [ ] `wc -l CLAUDE.md` under 150
- [ ] No fact appears in two files
- [ ] Every referenced file and symbol exists (`grep` it)
- [ ] New skill has `name` and a trigger-style `description`
- [ ] Dates on anything that can go stale
