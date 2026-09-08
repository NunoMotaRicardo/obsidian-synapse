---
name: synapse-lite
description: Quick one-pass implementation for a small change — no GitHub issue, no planner, no reviewer, but still build/lint/deploy-test. Opens a draft PR. Use only when the user explicitly asks for the "lite" cycle or invokes /synapse-lite.
---

# /synapse-lite "description"

A lighter-weight version of `/synapse-build` for small, low-risk changes. Skips the GitHub issue,
the `synapse-technical-planner`, and the `synapse-reviewer` — but **not** verification. See
`.docs/decisions/2026-06-14-github-issue-workflow.md`.

Only run this cycle when the user explicitly asks for "lite" — default to `/synapse-build`.

## Steps

1. Spawn the **synapse-coder** agent (foreground, lite mode) with the plain-text description. It:
   - creates/checks out `claude/<slug>`
   - implements in a single pass
   - builds, lints, and runs the **deploy-test** skill — required even in lite mode, only the
     issue/reviewer ceremony is skipped
   - updates `specs/<module>.md` if behavior changed
   - commits its work

2. Push and open a **draft** PR:
   ```bash
   git push -u origin claude/<slug>
   gh pr create --draft --title "<title>" --body "<summary of the change>"
   ```

3. Report the draft PR URL to the user and ask them to review.

## Rules
- No GitHub issue is created or referenced.
- Never merge, and never mark the PR ready-for-review automatically — that's the user's call.
- If the change turns out to be bigger than expected mid-implementation, stop and tell the user it
  probably needs `/synapse-build` instead.
