# Query metadata: capture-and-cache, not a persistent query (issue #130)

Status: **decided and implemented** (2026-09-04)

## Context

`Query.getContextUsage()`, `Query.supportedCommands()`, and `Query.supportedAgents()` (SDK
0.3.258, `sdk.d.ts:2723-2795`) existed with zero call sites in this codebase. They would drive
a real context-window indicator in the chat panel and replace the slash-command/agent-picker
directory scan (`scanVaultStructure()`/`scanAgents()`, `configWriter.ts`) with the CLI's own
authoritative view of what it actually loaded.

`Session` has no long-lived `Query` handle to call these on between turns — `Session.send()`
constructs a fresh `query()` per turn (`resume: this._sessionId` once known) and clears the
handle in a `finally` once the turn's stream ends (`agentService.ts`). Issue #130 existed to
pick one of two shapes before attempting any of the above:

1. **Persistent streaming-input query.** Restructure `Session` around one long-lived `query()`
   fed by an input stream. Unblocks everything, including live `setModel`/`setPermissionMode`,
   but touches session resume, abort, and the event-conversion loop — precisely the machinery
   #104 (`resolveResumeSessionId`/`resume` on rebuild) and #137 (`sdkSeenIndex`, the bridge
   that carries local-provider turns into the SDK session) depend on, both freshly verified
   working in a real vault.
2. **Capture-and-cache.** Keep the per-turn query, but call the `supported*`/`getContextUsage`
   control requests while a turn's `Query` handle is still live, and serve cached values
   between turns.

## Decision

**Option 2, capture-and-cache**, per the issue's binding decision comment. The payoff of
option 1 — a context indicator and marginally fresher command lists — does not justify
destabilising two freshly-confirmed fixes. If the accepted limitations below later prove
unacceptable, option 1 remains open as its own issue with its own risk assessment.

## Step 0 spike: the decision comment's timing assumption was wrong

The decision comment (written for #130, before this implementation) assumed control requests
could be made "at the end of each turn while the `Query` handle is still live" — i.e. after the
`for await (const msg of stream)` loop over the turn's `SDKMessage`s completes, before
`Session.send()`'s `finally { this.currentQuery = null }` runs.

This was tested empirically (a standalone script under a scratchpad temp dir, run from the repo
root so `@anthropic-ai/claude-agent-sdk` resolved from `node_modules`, driving `query()` against
the real installed `claude` CLI 2.1.258) and **found false**:

- Calling `getContextUsage({detail: 'summary'})` **after the `for await` loop ends** (i.e. once
  the stream is fully consumed) rejects: `ProcessTransport is not ready for writing`.
- Calling it **on receiving the terminal `SDKResultMessage`** (`msg.type === 'result'`), still
  inside the loop body, before any further `await`, also rejects:
  `Query closed before response received`.
- Calling it on **every message type that precedes `result`** — `system`, `assistant`,
  `rate_limit_event`, and even the second `system` message immediately before `result` —
  **succeeds**, every time, across repeated runs.

Real output from the spike (`detail: 'summary'`, 5-item counting prompt):

```
[msg] system
[getContextUsage after 'system' OK] total={"categories":[...]}
[msg] assistant
[getContextUsage after 'assistant' OK] total={"categories":[...]}
[msg] rate_limit_event
[getContextUsage after 'rate_limit_event' OK] total={"categories":[...]}
[msg] system
[getContextUsage after 'system' OK] total={"categories":[...]}
[msg] result
[getContextUsage after 'result' FAILED] Query closed before response received
```

**Conclusion: neither (a) end-of-stream nor (b) on-the-`result`-message works — the
process/transport is already gone by the time either of those points is reached in the
single-turn (string-`prompt`) mode this codebase uses.** The only safe window is *before* the
terminal `result` message is delivered to the consumer, at any earlier message. This is a
narrower window than the decision comment assumed, but it is still squarely inside the
capture-and-cache shape: a live `Query` handle exists, the process hasn't exited, and this is
simply the last point in the stream (not the notional "end of turn") where that's true.

**Correction applied:** `Session.send()` calls `refreshQueryMetadataCache()`
(`agentService.ts`) once per non-partial `assistant` SDKMessage — there can be more than one in
a tool-loop turn — with each call overwriting the previous. The cache therefore ends up holding
whatever was captured at the *last* `assistant` message of the turn, the closest available
approximation of "end of turn while still live" given the empirical constraint above. A turn
with zero `assistant` messages (e.g. an immediate error) leaves the cache untouched.

## Degradation contract

A failed control request must never fail the turn. `refreshQueryMetadataCache()` wraps the
three calls in `Promise.all` inside a `try`/`catch`: on any rejection, it returns the **previous
cache unchanged** (or the initial empty cache, if nothing had been captured yet) and emits one
`debugTrace()` line — nothing is thrown into `Session.send()`'s turn, and no `session.error`
event is dispatched for a metadata-capture failure. Verified in
`test/queryMetadataCache.test.ts` with a mocked `Query` whose calls reject.

## Accepted limitations (unchanged from the issue's decision comment)

- **Cached values are one turn stale.** Acceptable for a context indicator, which is an
  at-a-glance gauge, not a precise readout — and the toolbar's tooltip says so explicitly.
- **The CLI's mid-session slash-command push (`sdk.d.ts:3368`) cannot be received** — there is
  no live handle between turns to receive it on. A command discovered mid-turn appears one turn
  later, once the next `assistant` message triggers a fresh capture.
- **`reloadSkills()`/`reloadPlugins()` remain unavailable** for the self-improve refresh, since
  they need a handle at an arbitrary moment rather than at a message boundary inside an
  in-flight turn.

## What this unblocked, and what it didn't

- `Session.cachedContextUsage`/`cachedSupportedCommands`/`cachedSupportedAgents` (getters,
  `agentService.ts`) expose the cache; a `session.metadata` `SessionEvent` fires whenever a
  capture attempt (successful or not) completes, so the view can re-render without polling.
- The chat panel's context-window gauge (`configToolbar.ts`) reads `cachedContextUsage` and
  renders nothing — not a zero — until the first successful capture, and stays absent for the
  entire conversation on the BYOK local-model path (`executeLocalProviderQuery()` never touches
  a `Query` handle at all).
## Review correction: the CLI list decides membership, the vault scan supplies config

Review of the first implementation caught a regression in how the two lists were adopted. The
CLI's `AgentInfo` carries only `name`/`description`/`model` — it has no `tools` or `skills`,
because those are a vault-local concept. The first version replaced the scanned `AgentConfig`
wholesale with the mapped CLI one, and `applyAgentToolsAndSkills()` reads `skills: undefined`
as **"enable all"**. So a vault agent declaring `skills: [summarize]` had its restriction
silently discarded the moment the first capture landed — a deliberately narrowed agent quietly
widened to every skill, mid-conversation.

Fixed by merging rather than replacing (`mergeLiveAgents()`/`mergeLiveSkills()` in
`sessionConfig.ts`): **the CLI decides membership** — it is authoritative about which agents
actually loaded, so one the scan found but the CLI did not is genuinely unavailable and is
dropped — while **the directory scan supplies the config** for any entry present in both.
Covered by tests in `test/sessionConfig.test.ts`.

The same review moved `updateConfigUI()` off the `session.metadata` event. That event fires once
per `assistant` message, i.e. repeatedly *mid-turn*, and `updateConfigUI()` is not a read-only
render — it rebuilds the agent `<select>`, resets `selectedAgent` when the preferred list no
longer contains the current selection, and rewrites `enabledSkills`. Running it mid-turn would
mutate the session's own configuration while that session was answering. Only the read-only
gauge refreshes on `session.metadata`; the agent/skill lists refresh on `session.idle`, which is
also the point at which a one-turn-stale cache is meaningful.

- The slash-command popup (`inputArea.ts`) and agent picker (`configToolbar.ts`) prefer
  `cachedSupportedCommands`/`cachedSupportedAgents` (mapped to the existing `SkillInfo`/
  `AgentConfig` shapes by `mapSlashCommandsToSkillInfo()`/`mapAgentInfoToAgentConfig()` in
  `sessionConfig.ts`) and fall back to the directory scan (`this.skills`/`this.agents`) via
  `getEffectiveSkills()`/`getEffectiveAgents()` — unchanged behavior for a session that has
  never sent a turn, since the cache starts empty.
- Live `setModel`/`setPermissionMode` and the self-improve `reloadSkills()`/`reloadPlugins()`
  refresh remain out of scope — they need option 1 (a persistent query), which stays a
  candidate follow-up issue, not a quiet expansion of this one.

See `.docs/specs/agent-service.md`'s "Query metadata cache (issue #130)" and
`.docs/specs/chat-view.md`'s "Context-window gauge and live command/agent lists (issue #130)"
for the implementation-level detail.
