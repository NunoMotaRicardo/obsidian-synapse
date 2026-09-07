# Working-Directory Auto-Update: Deferral Removed After Empirical Testing (issue #131)

Status: **superseded** (2026-09-07)

Superseded by: [`2026-09-07-cwd-deferral-restored.md`](2026-09-07-cwd-deferral-restored.md) (issue #202)

> **The empirical findings below still stand.** The deferral was restored on 2026-09-07, but *not*
> because anything in this record was wrong: issue #104 really did fix transcript loss, and the
> path-handling test really did show graceful degradation under a changed `cwd`. Neither argument
> should be revived. What this record did not weigh is the **token cost** of the session rebuild —
> a resumed session replays the whole transcript into the prompt cache, which the "Consequences"
> section below treats only as a subprocess cost. See the superseding record for the measurements.

## Context

`decideWorkingDirAutoUpdate()` (`src/view/sessionConfig.ts`) deferred an active-note-driven
`cwd` change whenever a conversation was in progress. Its documented reason (issue #108,
likely root cause of #93) was that applying `cwd` mid-conversation forced `ensureSession()`
to tear down the live `Session` and build a replacement whose `_sessionId` started empty —
`Session.send()` only passed `resume` when `_sessionId` was truthy, so the next turn silently
started a fresh CLI session with no history.

Issue #104 removed that mechanism: `ensureSession()` now seeds the rebuilt `SessionConfig`
with the outgoing session's id (`resume`), and `Session.send()` falls back to it via
`resolveResumeSessionId()` whenever the new `Session`'s own `_sessionId` is still empty. So the
deferral's stated rationale no longer applied — it had become a workaround for a bug that no
longer existed.

The one remaining possible justification — never the documented reason, never verified — was
that resuming a CLI session under a *changed* `cwd` might degrade the model's handling of
paths referenced in earlier turns (the CLI resolves relative paths against the current `cwd`,
so an old relative reference could resolve incorrectly or the model could get confused about
which directory a prior reference belonged to).

Per the issue owner's comment on #131, this had to be settled empirically before either
removing or keeping the deferral — not decided by reasoning about type signatures.

## What was tested

A scratch Node script (not committed; run from a scratchpad temp directory, using
`@anthropic-ai/claude-agent-sdk`'s `query()` directly against a real `claude` CLI) ran:

1. **Turn 1** — `query()` with `cwd` = folder A (containing `notes.txt`, content
   `"the secret code is BANANA-42"`). Prompt asked the model to read `notes.txt` by
   *relative* path.
2. **Turn 2** — same session resumed (`resume: <turn 1 session id>`) with `cwd` = folder B
   (a different temp folder, containing `other.txt`, content `"the secret code is
   KIWI-77"`). Prompt asked the model to (a) recall the secret code from `notes.txt` based on
   the earlier turn, *without* re-reading it, and (b) separately read `other.txt` by relative
   path (which should resolve against B).
3. **Turn 3 (control)** — same session resumed again with `cwd` back to folder A, asking it
   to re-read `notes.txt` by relative path, to confirm the session and cwd machinery still
   behaved normally after the round-trip.
4. **A second run's edge case** — same session resumed with `cwd` = folder B, but this time
   explicitly asked the model to *re-read* `notes.txt` "using the exact same relative path you
   used a moment ago" (i.e. deliberately provoke a stale relative reference against the new
   `cwd`), to see whether it would hallucinate content or fail correctly.

## What was observed

- **Turn 1:** correctly read `notes.txt` from folder A, reported `BANANA-42`.
- **Turn 2:** correctly recalled `BANANA-42` from the transcript without re-reading, and
  correctly read `other.txt` against the new `cwd` (folder B), reporting `KIWI-77`. No
  confusion between the two folders.
- **Turn 3:** correctly re-read `notes.txt` against folder A again after the `cwd` had
  round-tripped through B, confirming `BANANA-42`.
- **Edge case:** when explicitly asked to re-read `notes.txt` via the same relative path
  while `cwd` was still folder B, the model attempted the read, got a file-not-found result,
  and reported that plainly — including correctly reasoning that its earlier successful read
  "apparently resolved against a different working directory (likely folder A)". It did not
  hallucinate content or silently reuse the stale value as if it were freshly verified.

Across both runs (3 + 1 = 4 turns, 2 independent sessions), resuming under a changed `cwd`:
- did not lose or corrupt the model's memory of earlier-turn content,
- correctly resolved new relative paths against the new `cwd`,
- and degraded *gracefully* (a clear "not found", not a hallucination) when a genuinely stale
  relative reference was forced against the new `cwd`.

**Confidence:** high for the scenarios tested (single resumed session, cwd changed once or
twice, relative-path reads via the `Read` tool). Not exhaustively tested against every tool
or a long multi-hop `cwd` history, but the SDK's `Read` tool is the dominant path-resolution
surface in this plugin's usage and the mechanism (resolve against the *current* `cwd`, don't
assume anything about earlier turns) behaved consistently and safely across every turn.

## Decision

Path handling does **not** degrade under a `cwd` change mid-conversation. The deferral is
**removed**. `decideWorkingDirAutoUpdate()` now only checks whether the active note's folder
actually changed and, if so, returns `true` unconditionally — `updateActiveNote()`
(`src/view/inputArea.ts`) applies `workingDir`/`configDirty` immediately regardless of whether
a conversation is in progress. `SynapseView.pendingWorkingDir` and the "apply on next
`newConversation()`" logic are removed as dead code.

## Consequences

- Switching to a note in a different folder mid-conversation now moves the working-directory
  button immediately, matching what the UI already visually implies.
- The next message after a note switch now always rebuilds the `Session` (as any other
  `configDirty` toggle already did) — this was already true when a conversation was *not* in
  progress, and issue #104 made that rebuild cheap in terms of history (still carries
  `resume` forward). The extra subprocess-per-switch cost is unchanged from before #131 for
  the "no conversation in progress" case, and is now paid consistently instead of
  sometimes-deferred.
- No new UI was added to surface a "pending directory" state, because there is no longer a
  pending state to surface.

## Testing artifacts

The scratch script and its output are not committed (per instructions, scratch work stayed in
the session scratchpad, not the repo). This record captures the prompts, setup, and observed
results in full; re-running the same protocol against `@anthropic-ai/claude-agent-sdk`'s
`query()` with `resume` + a changed `cwd` should reproduce it.
