# GitHub-native issue workflow for the Claude Code dev agents

## Context

The `.claude/agents/sidekick-*` pipeline (analyst → technical-planner → coder → reviewer)
originally assumed local `issues/NNNN-*.md` files as the work-item source of truth, mirroring
this repo's GitHub issues on `NunoMotaRicardo/obsidian-copilot`. Commit `ad623af` deleted the
local mirror (`issues/0001-0008`). Checking GitHub showed issues #1-#8 were already tracked
there (#2, #4, #5, #6 still open; #1, #3, #7, #8 closed) — the local files were pure
duplication, not lost work.

## Decision

GitHub issues on `NunoMotaRicardo/obsidian-copilot` are the **single source of truth** for
Claude Code dev-agent work items. There is no local `issues/` folder, and
`.claude/skills/issue-workflow/` is retired. Two orchestrating skills drive the work:

- **`/sidekick-build <#N | "description">`** — full cycle. sidekick-technical-planner first
  audits the request and checks it's feasible as one cycle (one coder pass + up to 3
  coder↔reviewer rounds); if not, it splits the work into sub-issues and stops for the user to
  pick one. Otherwise: label the issue `in-progress`, run sidekick-coder, then
  sidekick-reviewer; loop on CHANGES REQUESTED (max 3 rounds — after the 3rd, stop and report
  the branch + findings instead of looping forever). On APPROVED, push `claude/<slug>` and
  open a ready PR (`Closes #N`, body = reviewer's draft).
- **`/sidekick-lite "description"`** — quick fixes. No issue, no planner, no reviewer.
  sidekick-coder implements + still runs `deploy-test` (the only thing skipped is the
  issue/reviewer ceremony, not verification) + updates specs if behavior changed, then pushes
  `claude/<slug>` and opens a **draft** PR for the user to look at.

Status tracking uses GitHub issue state (open/closed) plus an `in-progress` label (created on
first use) for "actively being worked".

`/sidekick-build` and `/sidekick-lite` **never merge**. The user plus a separate GitHub-side
review agent handle final review/merge — the cycle's job is to get a ready (or draft) PR
opened.

## Rationale

- The user works github.com-first; a local mirror was duplication/sync friction.
- "Reviewer happy" is the natural end of the *internal* cycle — final review/merge stays
  external, so the cycle stops at "PR opened".
- A feasibility/splitting check up front avoids burning review cycles on oversized issues.

## Scope / Non-goals

- No GitHub Projects/boards, no `spec:`/`module:` label taxonomy — specs are linked by path in
  issue/PR bodies instead.
- No auto-merge, ever.
- `/sidekick-lite` never creates or touches a GitHub issue.

## Hand-off Notes for the Technical Planner

- Issue creation/editing via `gh issue create|edit|view|list` against
  `NunoMotaRicardo/obsidian-copilot`.
- Reuse the repo's existing labels (`bug`, `enhancement`, `documentation`, ...) for type; add
  `in-progress` (create via `gh label create` if it doesn't exist) for active work.
- Issue body: Summary, Acceptance Criteria, Technical Notes (link `specs/<module>.md`),
  `Depends on` / `Part of #N` for slices.
- Branch naming stays `claude/<slug>` (matches existing PR history, e.g. PRs #9-#12).
