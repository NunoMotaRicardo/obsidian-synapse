# Working-Directory Auto-Update: Deferral Restored on Token-Cost Grounds (issue #202)

Status: **decided and implemented** (2026-09-07) — merged in PR #204

Supersedes: [`2026-09-03-cwd-deferral-removed.md`](2026-09-03-cwd-deferral-removed.md) (issue #131)

## Context

Four days after the deferral was removed, a cost investigation into a real chat session found
that switching the active note mid-conversation was the single largest driver of token spend in
the plugin.

The session (2026-09-07, in the user's `vault_nmr`) billed **1,428,335 input tokens across 25 API
calls** for a conversation whose context never exceeded ~77K tokens. A single user turn — four
tool-using round trips — cost 299,264 input tokens. Two turns inside one 5-hour window consumed
roughly 15% of the limit.

Two mechanisms were responsible. The smaller one (volatile fields in the appended system prompt,
issue #201) is recorded separately. The larger one is the subject of this record: an
active-note-driven `cwd` change sets `configDirty`, which makes `ensureSession()` tear down and
rebuild the live `Session`. The rebuild resumes by id, and **a resumed session is a new CLI
process that replays the entire transcript** — so every note switch across a folder boundary
caused the whole conversation to be written to the prompt cache again, at cache-write price
rather than cache-read price.

Because users switch notes constantly *between* turns, this fired on a large share of follow-up
messages.

## What the superseded record got right — and what it missed

The 2026-09-03 record is **not** being reversed on its findings. Both of the deferral's original
justifications were genuinely disproven, and both remain disproven:

1. **Transcript loss** — really was fixed by issue #104's `resume` fallback. No conversation is
   dropped by a mid-conversation rebuild.
2. **Degraded path handling under a changed `cwd`** — really was tested empirically across two
   independent sessions and four turns, and really does degrade gracefully. The model recalled
   earlier-turn content without re-reading, resolved new relative paths against the new `cwd`,
   and reported a clean "not found" rather than hallucinating when a stale relative reference was
   deliberately forced.

Neither finding is re-litigated here, and neither should be revived as an argument in future code
comments or specs.

What the earlier analysis missed was a **third consideration it never weighed: the token cost of
the rebuild.** Its "Consequences" section came close, noting that "the next message after a note
switch now always rebuilds the `Session`" and calling the effect an "extra subprocess-per-switch
cost… now paid consistently instead of sometimes-deferred." That framing treated the rebuild as a
*process* cost — a subprocess spawn, measured in latency — and concluded it was acceptable. It did
not account for the rebuild also being a *prompt-cache* event: the replayed transcript is re-billed
as cache-writes, which grow with conversation length. A cost that looks negligible per switch when
measured in subprocess spawns is substantial when measured in tokens, and it scales with exactly
the thing that makes a conversation valuable — its length.

This is the honest shape of the reversal: the earlier decision was correct on everything it
examined, and incomplete in what it chose to examine.

## Decision

Restore the deferral. While a conversation is in progress, an active-note-driven `cwd` change is
held rather than applied, and takes effect when the next conversation begins.

Deliberately unchanged:

- **Manual working-directory overrides apply immediately.** Dragging a folder onto the input area
  is an explicit user action, not a silent side effect of navigation, and is not deferred.
- **The `autoUpdateWorkingDirectory` setting remains the global on/off switch.** This decision
  changes only *when* an enabled auto-update takes effect, not whether the feature exists.
- **Returning to the current folder cancels a pending change.** A user who glances at a note in
  another folder and comes back before ending the conversation should end up where they actually
  are, not where they briefly visited. (This corrected a latent bug in the pre-#131
  implementation, which left the abandoned directory pending — see PR #204.)

## Rationale

Deferring costs the user a working directory that lags the active note during a conversation.
Applying immediately costs a full transcript replay on most follow-up messages. The first is a
minor and recoverable inconvenience; the second scales with conversation length and is invisible
to the user until the bill arrives.

Path resolution does not meaningfully suffer from the lag: the vault root is always available in
the system prompt, and the active note's absolute path is delivered with every turn (issue #201),
so the model can still find the note the user is looking at — it resolves it by absolute path
rather than by `cwd`.

Alternatives considered and rejected:

- **Leave it as-is and accept the cost.** Rejected: the measured spend was severe enough to be the
  user's primary complaint, and there is no user-visible benefit to immediate application beyond
  the toolbar button matching the active note sooner.
- **Turn off `autoUpdateWorkingDirectory` by default.** Rejected: it throws away a genuinely useful
  behavior to solve a timing problem, and would surprise existing users.
- **Make the rebuild cheaper instead of avoiding it.** Rejected as out of reach — the replay is the
  SDK's session-resume mechanism, not something the plugin controls.

## Scope / Non-goals

- Does not revisit issue #104's `resume` fallback or issue #131's path-handling findings, both of
  which stand.
- Does not change the manual override path, the `autoUpdateWorkingDirectory` setting, or any
  toolbar-toggle `configDirty` behavior (agent, model, reasoning, tools).
- Does not address the separate system-prompt caching issue (#201 / PR #203), recorded elsewhere.
- No UI was added to surface the pending-directory state. Whether users need that signal is open.

## Open Questions

- **Should the pending state be visible?** The working-directory button silently lags the active
  note mid-conversation. That was the pre-#131 behavior and drew no complaints, but it was also
  never explicitly evaluated. If users report confusion, a subtle indicator is the obvious fix.
- **Is `currentSession !== null && messages.length > 0` the right definition of "in progress"?** It
  is inherited from the original implementation and works, but a conversation the user has
  abandoned without starting a new one holds a pending change indefinitely.
- **End-to-end confirmation is still outstanding.** The fix is verified by construction — no
  `configDirty` means `ensureSession()` returns early, so no rebuild occurs — and the behavior was
  exercised in the real vault. A live multi-turn session confirming the absence of full-transcript
  cache re-creation in the JSONL has not been captured.

## Hand-off Notes for the Technical Planner

No new technical work is requested by this record; issue #202 is implemented and merged (PR #204),
and the spec update to `chat-view.md` shipped with it.

Two items may warrant issues if the user wants them pursued:

1. A visible indicator for a pending working-directory change, if the silent lag proves confusing.
2. A follow-up to capture the end-to-end JSONL evidence, closing the verification gap noted above.

Both are speculative and should not be filed pre-emptively.
