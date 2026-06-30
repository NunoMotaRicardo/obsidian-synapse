---
name: synapse-build
description: Full build cycle for a GitHub issue or feature description — plan/scope, implement, review (up to 3 rounds), and open a PR. Use when the user asks to build, implement, or fix something via the synapse agent pipeline, or invokes /synapse-build.
---

# /synapse-build <#N | "description">

Orchestrates the full plan → implement → review → PR cycle for one GitHub issue on
`NunoMotaRicardo/obsidian-claude-brain` (the repo that `origin` points to). See
`wiki/decisions/2026-06-14-github-issue-workflow.md` for the design rationale.

Planning and review run **in the main thread** (the `synapse-technical-planner` and `synapse-reviewer`
skills); only implementation is delegated to the **synapse-coder** agent, for context isolation
during long iterative work.

## Steps

1. **Plan & scope** — run the **`synapse-technical-planner`** skill with the input (`#N` or the
   description).
   - If given a description, it creates the GitHub issue.
   - If given an existing issue, it audits feasibility (one coder pass + ≤3 review rounds).
   - **If it reports "Needs splitting"** — relay the sub-issues to the user and **stop**. Do not
     auto-proceed; the user picks which sub-issue to build next.
   - **If it reports "Feasible as one cycle — ready: #N"** — continue to step 2.

2. **Mark in-progress** — `gh issue edit #N --add-label in-progress` (create the label on first
   use if it doesn't exist yet).

3. **Derive the branch name** — `claude/<slug>` from the issue title.

4. **Build/review loop** (max 3 rounds):
   - Spawn the **synapse-coder** agent (foreground, full mode) with the issue number and branch
     name. On rounds 2-3, also pass the previous round's reviewer findings.
   - Run the **`synapse-reviewer`** skill in the main thread to review `git diff main`.
   - **APPROVED** → break to step 5.
   - **CHANGES REQUESTED** and round < 3 → loop back to the coder with the findings.
   - **CHANGES REQUESTED** at round 3 → **stop**. Report the branch name, issue number, and the
     reviewer's findings to the user. Do not push or open a PR.

5. **Push & open PR**:
   ```bash
   git push -u origin claude/<slug>
   gh pr create --title "<title>" --body "<reviewer's PR description draft>"
   ```
   The PR body is the reviewer's "PR description draft" verbatim (includes `Closes #N`).
   Report the PR URL to the user.

## Rules
- Never merge — the user (and a separate PR-review pass) handle final review/merge.
- Never skip the planner's feasibility check, even for issues that look small.
- If any step fails unexpectedly (build broken, `gh` not authenticated, etc.), stop and report
  rather than guessing a workaround.
