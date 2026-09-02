---
name: synapse-technical-planner
description: Translate functional intent (.docs/decisions/) into authoritative technical specs in .docs/specs/ and GitHub issues on the repo origin points to. Use to audit a request (an existing issue or a feature description), decide whether it fits one coding cycle or must be split, and own .docs/specs/<module>.md updates. Requires gh CLI auth.
---

# synapse-technical-planner — specs + GitHub issues

Use this skill (in the main thread) to bridge functional intent and implementation. It owns
`.docs/specs/` and the repository's **GitHub issues** on the repo `origin` points to — there is
no local `issues/` folder; GitHub is the single source of truth (see
`.docs/decisions/2026-06-14-github-issue-workflow.md`). For a heavy audit across many
`.docs/specs/`/`src/` files, spawn a generic `Explore` agent for the read-only sweep, then plan
here with its findings.

## Inputs & ownership

| Source | Use |
|---|---|
| `.docs/decisions/`, `.docs/research/` | functional/product intent (read-only) |
| `src/` (current codebase) | what already exists — always audit before planning |
| `.docs/specs/` | **owned here** — single source of truth for implementers |
| GitHub issues | **owned here** — `gh issue create/edit/view/list` |

Never write application code (`synapse-coder`'s job) and never write to `wiki/` or
`.docs/decisions/` (`synapse-analyst`'s job).

## .docs/specs/ structure (flat — no layers/modules/interfaces subfolders)

```
.docs/
  architecture.md      # overview + module table (one row per spec file)
  specs/
    <module>.md        # one file per module
```

Each module spec is freeform prose matching the existing style: a short "Source: `src/...`"
pointer, then responsibilities/groups, invariants, data passed through, gotchas. Reference open
issues inline ("Planned: X (issue #N)"). If a module has no spec yet, add a row to
`.docs/architecture.md`'s module table and create `.docs/specs/<module>.md` in the same style.

## Architecture method
- A **module** = interface + implementation; an **interface** = everything a caller must know.
- Prefer **deep** modules (much behavior behind a small interface). Flag **shallow** modules and
  apply the **deletion test** — if deleting it concentrates complexity across callers, it earns
  its keep; otherwise propose inlining.
- Watch for friction: a concept scattered across `src/view/*`/`src/modals/*`, tight coupling/
  leakage, untested paths. Record significant structural choices as a "## Invariants" or
  "## Decisions" note in the relevant `.docs/specs/<module>.md`. Reuse domain terms from `wiki/`.

## Feasibility & scoping (entry point of /synapse-build)

Given an existing issue number or a free-text description:

1. **Audit** — read `.docs/architecture.md` + relevant `.docs/specs/<module>.md`, skim affected
   `src/`. For an existing issue, `gh issue view <N>` and re-check its ACs against reality.
2. **Decide fit** — roughly one coder pass + a normal review round (≤3)? Think "one demonstrable,
   deploy-testable behavior change."
3. **If it fits:** for a description, `gh issue create` (template below) and report the number; for
   an existing issue, confirm/refresh it. End with: "Feasible as one cycle — ready: #<N>."
4. **If it doesn't fit:** split into smaller independently-demonstrable issues, cross-referencing
   `Part of #<original>` / `Depends on #<earlier>`. Leave an oversized input issue open as a
   tracker with a comment listing sub-issues. End with: "Needs splitting — created #<a>, #<b>, …"
   and **stop** — `/synapse-build` does not auto-proceed past a split.

## GitHub issues — vertical slices

Decompose into **independently verifiable vertical slices** — each demonstrable end-to-end via the
`deploy-test` skill after merge.

Issue body template:
```markdown
## Summary
1-2 sentences: what this delivers and why.

## Acceptance Criteria
- [ ] AC-1 (observable in the running plugin)
- [ ] AC-2

## Technical Notes
Patterns, contracts (link .docs/specs/<module>.md sections), constraints the coder must follow.

## Depends On / Part Of
#<issue> (omit if none)
```

Reuse existing labels (`bug`, `enhancement`, `documentation`, …). Use `in-progress` to mark active
work (create it if missing: `gh label create in-progress --color FBCA04`). Slicing rules: each
issue demonstrable after merge; make shared-foundation issues first. Prefer small issues (hours).

## After an issue is implemented
The merged PR's `Closes #N` closes it automatically. `synapse-coder` updates the relevant
`.docs/specs/<module>.md` as part of its diff — run the **deploy-test** skill after merge to
confirm the change is demonstrable. If you notice a stale spec later, update it.

## Rules
- Always audit existing code before planning — never plan work that already exists.
- Every issue has acceptance criteria a reviewer can verify against the running plugin.
- Keep `.docs/specs/` authoritative and current.
- Don't invent a label taxonomy beyond `in-progress` + existing type labels; no GitHub
  Projects/boards (see `.docs/decisions/2026-06-14-github-issue-workflow.md`).
