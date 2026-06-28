---
name: sidekick-pr-review
description: Review a GitHub pull request for inconsistencies, security, code quality, and against the issue that originated it. Optionally implement fixes, commit them, and comment on the PR. Use when asked to review or verify a PR (e.g. /sidekick-pr-review <#N>).
---

# /sidekick-pr-review <#N>

Checks out, reviews, and updates an existing GitHub pull request on `NunoMotaRicardo/obsidian-copilot`. This is a unified workflow combining review, feedback, and targeted fixes.

## Steps

1. **Checkout the PR** — Fetch and switch to the PR branch using the GitHub CLI:
   ```bash
   gh pr checkout <#N>
   ```
   Verify the local working tree is clean.

2. **Find the Originating Issue** — View the PR details:
   ```bash
   gh pr view <#N>
   ```
   Identify the closing issue number (e.g., `Closes #37` or `closes #30`) from the description or title. If found, fetch its requirements:
   ```bash
   gh issue view <Issue-Number>
   ```

3. **Static Checks** — Run local checks to verify the PR currently compiles and lints cleanly:
   - Lint check: `npm run lint`
   - Build check: `npm run build`

4. **Review the PR** — Retrieve the PR's code diff:
   ```bash
   git diff main...HEAD
   ```
   Perform a deep code review of the diff, evaluating against:
   - **Originating Issue**: Are all Acceptance Criteria (ACs) and technical notes of the originating issue fully met?
   - **Inconsistencies**: Are there any internal logic inconsistencies, redundant checks, double-formatting bugs, or mismatch with the specifications (`specs/*.md`)?
   - **Security**: Verify SAST issues, secrets, RCE, and network safety (gated by Obsidian plugin constraints).
   - **Code Quality**: Ensure strict type safety, clean control flow, lack of duplicates, and alignment with repository styles (tabs, single quotes, etc.).

5. **Generate Review Report** — Write a comprehensive review report to a local markdown artifact:
   - Path: `<appDataDir>/brain/<conversation-id>/pr_<#N>_review.md`
   - Structure the report with: Inconsistencies & UX Gaps, Security Review, Code Quality & Maintenance, and Proposed Fixes.

6. **Post Review Comments** — Post a summary of the findings as a comment on the GitHub PR:
   - Create a scratch comment file at `<appDataDir>/brain/<conversation-id>/scratch/pr_<#N>_comment.md`.
   - Post it using:
     ```bash
     gh pr comment <#N> -F "<scratch-comment-filepath>"
     ```

7. **Implement & Verify Fixes** (If requested or needed):
   - Implement target refactoring and fixes locally on the checked-out PR branch.
   - Run `npm run lint` and `npm run build` to ensure they compile clean.
   - Run `deploy-test` (`.claude/skills/deploy-test/`) to verify in the actual Obsidian vault.
   - Stage and commit the fixes:
     ```bash
     git add <modified-files>
     git commit -m "<clean, descriptive message>"
     ```
   - Push to the remote branch:
     ```bash
     git push origin HEAD
     ```
   - Post a follow-up comment on the PR detailing the pushed fixes.

## Rules
- **No New Agent Needed**: This workflow is orchestrated directly by the main agent (Antigravity/self) as it requires a hybrid capability of coding, reviewing, and GitHub CLI execution.
- **Do Not Merge**: The final review/merge of the PR must stay external (handled by the user).
- **Security & Quality**: Never commit/push if build or lint checks fail.
