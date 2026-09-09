# Mercur fix-cycle agents

Four agents that run **in a fixed order** as one group. They are idle until
invoked — nothing here runs on its own.

```
  mercur-po       scope + product decisions      -> fix-cycle/01-po-work-order.md
        |
  mercur-qc       acceptance gates               -> fix-cycle/02-qc-gates.md
        |
  mercur-tester   failing reproductions          -> fix-cycle/03-test-report.md
        |
  mercur-dev      implement as overlays          -> fix-cycle/04-dev-log.md
        |
  mercur-qc       final review (second pass)     -> fix-cycle/05-qc-verdict.md
```

## Why the developer runs last

Spec first, then gates, then failing tests, then code. By the time `mercur-dev`
starts, scope is settled, "done" is written down, and every defect has a
reproduction that currently fails. The developer's job is to turn red to green —
not to decide what to build or whether a finding is real.

`mercur-qc` runs twice: it writes the gates, and later judges against them.

## Invoking them

One stage at a time, checking the handoff file before continuing:

```
Use the mercur-po agent to triage FIX-PLAN.md for this cycle.
Use the mercur-qc agent to set gates for the work order.
Use the mercur-tester agent to reproduce every scheduled item.
Use the mercur-dev agent to implement the scheduled fixes.
Use the mercur-qc agent to review the implementation.
```

Each stage reads the previous stage's artefact from `fix-cycle/`. A stage whose
input is missing should stop rather than improvise.

## Shared constraints (every agent enforces these)

- **Rule 0** — never edit an upstream-tracked file in a commit. Fixes to upstream
  code ship as patches in `deploy/overlays/`. Adding a *new* file is always fine.
  `deploy/`, `docker-compose*.yml`, `CLAUDE.local.md`, `LOCAL-SETUP.md`,
  `FIX-PLAN.md` and `.claude/` are ours to edit directly.
- Invariant check — always against the merge-base, never `upstream/main`:
  ```bash
  git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"
  ```
- `bun` only. `bun x`, never `bunx`. Never bare `bun run test:integration:http`.
- Never add `any` or `@ts-ignore`.
- Do not commit unless the human asks. No AI attribution in commits or PRs.
- Treat `.claude/skills/mercur/SKILL.md` claims as unverified — it has been wrong
  (it documented scheduled jobs that do not exist in the codebase).

## Source of truth

`FIX-PLAN.md` in the project root holds the audited findings, ranked, with the
delivery mechanism for each. The PO triages from it; everyone else works from the
`fix-cycle/` artefacts.
