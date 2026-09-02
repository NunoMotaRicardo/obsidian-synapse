---
name: synapse-pr-review
description: Review a GitHub pull request for inconsistencies, security, code quality, and against the issue that originated it. Optionally implement fixes, commit them, and comment on the PR. Use when asked to review or verify a PR (e.g. /synapse-pr-review <#N>).
---

# /synapse-pr-review <#N>

Reviews, and optionally fixes, an existing GitHub pull request on the repo `origin` points to.
Run directly in the main thread. Shares its checkout/verify/commit/push steps with
`synapse-pr-comments` — see `.claude/skills/pr-workflow-shared.md` — differing only in what
drives the fixes: this skill reviews the PR's **diff**; `synapse-pr-comments` addresses
**unresolved review threads**.

## Steps

1. **Checkout the PR** — see "Checkout" in `.claude/skills/pr-workflow-shared.md`.

2. **Find the originating issue** — `gh pr view <#N>`. Identify the closing issue number (e.g.
   `Closes #37`) from the description or title. If found, `gh issue view <Issue-Number>`.

3. **Review the diff** — `git diff main...HEAD`. Run **`/code-review`** and **`/security-review`**
   on it, the same built-ins `synapse-reviewer` uses — don't hand-maintain a second copy of that
   rubric. Cross-reference the findings against the originating issue's Acceptance Criteria and
   `.docs/specs/*.md`.

4. **Write the review** — save it to a file in the session scratchpad directory (see your system
   prompt for the path), structured: Inconsistencies & UX Gaps, Security Review, Code Quality &
   Maintenance, Proposed Fixes.

5. **Post review comments** — post the findings as a comment on the GitHub PR:
   ```bash
   gh pr comment <#N> -F "<scratchpad-file>"
   ```

6. **Implement & verify fixes** (if requested or needed) — see "Verify, commit, push" in
   `.claude/skills/pr-workflow-shared.md`, then post a follow-up comment on the PR detailing the
   pushed fixes.

## Rules
- **No new agent needed**: this workflow is orchestrated directly in the main thread (it needs a
  hybrid of coding, reviewing, and GitHub CLI execution).
- **Do not merge**: the final review/merge of the PR stays external (handled by the user).
- **Security & quality**: never commit/push if build or lint checks fail.
