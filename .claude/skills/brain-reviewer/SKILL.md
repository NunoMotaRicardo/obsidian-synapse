---
name: brain-reviewer
description: Quality + security gate run after brain-coder in the /brain-build cycle. Reviews ONLY the current branch's diff against main for correctness, issue/spec adherence, Obsidian plugin conventions, and security. Reuses /code-review and /security-review. Produces a pass/fail verdict and, on APPROVED, the PR description body. Use to review a freshly-coded branch before opening a PR.
---

# brain-reviewer — quality + security gate

Use this skill (in the main thread) as the combined code-quality and security gate. It **never
writes code** — it reports a verdict.

## Scope — only the current branch's diff
```bash
git diff main --name-only
git diff main
```
Cross-reference against:
- the GitHub issue (`gh issue view <N>`) — were all ACs met, and does the coder's summary describe
  a real deploy-test (reload + behavior check), not just "build passes"?
- `specs/00-architecture.md` + relevant `specs/<module>.md` — does the code match documented
  module boundaries and contracts?
- existing `src/` patterns and CLAUDE.md conventions.

## Method
1. Run `npm run build` (tsc strict + esbuild) and `npm run lint` (eslint + eslint-plugin-obsidianmd).
   Both must be clean.
2. Run **`/code-review`** on the diff for correctness/simplification/efficiency findings.
3. Run **`/security-review`** for the security gate (folded-in SAST step).
4. Apply the checklist below.

## Checklist
**Correctness** — all ACs implemented; edge/failure paths handled (CLI not installed, SDK
disconnect, missing settings); happy path correct.

**Specs & module boundaries** — matches the relevant `specs/<module>.md`; SDK access stays behind
the single service module (`src/copilot.ts`) — no module imports the agent SDK directly except
type-only imports; `src/main.ts` stays lifecycle-only; vault customization parsing stays in
`src/configLoader.ts` / `src/view/sessionConfig.ts`.

**Verification** — `npm run build` and `npm run lint` clean; the coder's summary describes an actual
deploy-test (reload + behavior check), not just "build passes."

**Clarity & conventions** — tabs, single quotes, no trailing-semicolon omission; no dead/
commented-out code; named constants not magic numbers; intention-revealing names; Obsidian UI copy
is sentence case with **bold** literal labels and arrow navigation; no needless complexity.

**Completeness & safety** — no TODO/FIXME/placeholder code; debug output through `debugTrace`/
`src/debug.ts` (gated), not raw `console.log`; no secrets/keys/tokens, none in `data.json`; all new
listeners/intervals/timers use Obsidian `register*` helpers; no command-ID or settings-key renames
without a migration path; new network calls are user-visible, justified, documented.

## Output
```markdown
## Review — issue #NNN
### Verdict: APPROVED | CHANGES REQUESTED
### Security gate: PASS | PASS WITH WARNINGS | FAIL
### Findings
#### [BLOCKING|NON-BLOCKING] <title>
- File: `path` line N
- Category: Correctness | Specs | Verification | Clarity | Completeness | Security
- Description / Suggestion
### Build & lint
<npm run build / npm run lint summary>
### PR description draft
**Title:** <imperative, matches issue title>
**Body:** Summary / Changes / Acceptance Criteria checklist (checked) / Security: PASS

Closes #NNN

(+ Claude Code trailer)
```

On **APPROVED**, the "PR description draft" body is used verbatim as `gh pr create --body` — write
it as the final PR body, not notes to a human.

## Rules
- Any **BLOCKING** finding, failing build/lint, or **security FAIL** ⇒ CHANGES REQUESTED; the
  build loop sends it back to `brain-coder` (max 3 rounds — if round 3 still has issues, report
  CHANGES REQUESTED honestly and let the loop escalate to the user).
- APPROVED with NON-BLOCKING findings ⇒ proceed, listing them under "Known follow-ups" in the PR body.
- Out-of-scope issues ⇒ note as "out of scope — log separately", do not fix.
- Never modify code; never approve with a failing build, failing lint, or a missing/weak deploy-test.
