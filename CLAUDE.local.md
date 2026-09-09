# CLAUDE.local.md — local workspace facts (not upstream)

Companion to the tracked `CLAUDE.md`. `CLAUDE.md`, `docs/`, and
`.claude/skills/{figma-ui,linear-task,playwright-skill}` are **upstream files —
do not edit them**.

## What this workspace is

A **pristine mirror** of `mercurjs/mercur` `main`, cloned at `da34c523f`
(`chore: v2.3.4-canary.5`, 2026-09-08).

| Remote | URL |
|---|---|
| `origin` | `https://github.com/kt-dev-repo/mercur-multivendor-marketplace.git` |
| `upstream` | `https://github.com/mercurjs/mercur.git` (push disabled) |

**Standing rule: never modify an upstream-tracked file.** Everything added here
is a *new* file sitting beside upstream ones, so `git diff upstream/main` shows
only additions and `git merge upstream/main` can never conflict.

Local additions (committed on `main`):
- `docker-compose.postgres.yml`, `docker-compose.redis.yml` — Postgres 16 and
  Redis 7 as two independent services (separate compose projects), run under
  **Podman**
- `CLAUDE.local.md` — this file
- `LOCAL-SETUP.md` — the runbook
- `.claude/skills/medusa/`, `.claude/skills/mercur/` — local skills
  (`.gitignore` ignores `.claude`, so these are force-added — the same way
  upstream tracks its own skills)

Never committed: `apps/api/.env`, `apps/storefront/.env.local` (gitignored upstream).

The older clone at `../mercur` (fork `kt-dev-repo/mercur`) shares **no git
ancestor** with upstream and has a different layout. It is a separate project —
do not try to merge the two.

## Local skills

- `.claude/skills/mercur/SKILL.md` — domain model, package map, run commands, verified gotchas
- `.claude/skills/medusa/SKILL.md` — Medusa 2.x modules/workflows/links/migrations/tests

## Actual ports (upstream docs disagree — trust this table)

| Service | Port | Note |
|---|---|---|
| `apps/api` | 9000 | |
| `apps/storefront` | 3000 | Next.js; not in the CLI scaffold |
| `apps/admin-test` | **7001** | docs say 7000 — that is the `preview` port |
| `apps/vendor` | **7002** | docs say 7001 — that is the `preview` port |
| Postgres | 5432 | container `mercur-postgres`, own compose file |
| Redis | 6379 | container `mercur-redis`, own compose file |

## Container engine

Podman Desktop owns `/var/run/docker.sock` here, so the `default` docker context
resolves to Podman 6.1.0 (`linux/arm64/fedora-44`). `docker compose` and
`podman compose` are equivalent on this machine; prefer `podman`.

## Toolchain gotchas

- No `bunx` — use `bun x`.
- `bun run test:unit` needs `node_modules/@swc/{jest,core}` symlinked from
  `integration-tests/node_modules` (bun does not hoist them; `--rootDir ..`
  makes Jest look at the root). Re-apply after a clean install.
- Integration tests need a `postgres` superuser role in Postgres, because
  `integration-tests/.env.test` hardcodes `postgres:postgres`.
- Store cart line items take `offer_id`, never `variant_id`.

## Commit policy conflict — ask before committing

Upstream `CLAUDE.md` forbids mentioning AI assistants in commits and PRs (no
`Co-Authored-By: Claude`, no footers, no 🤖). The session default is to add those
trailers. **The repo rule wins**, but confirm with the user at the first commit.
