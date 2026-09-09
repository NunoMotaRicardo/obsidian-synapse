# run-executor

## Overview

`src/runExecutor.ts` is the per-item run pipeline behind "run a prompt against a file, then persist
the result": substitute template variables, run via `AgentService.inlineChat()`, apply a write
mode, append a report entry. `batchLoopExecutor.ts` ([batch-loops.md](batch-loops.md)) is its one
caller and is a thin one — it supplies what's actually caller-specific: which file(s) to run over,
where the prompt body comes from, how a report block is formatted, and budget/cancellation/progress
orchestration across many items.

Model for this extraction: `src/budget.ts` (#74) and `src/vaultPaths.ts` (#153) — small, focused
modules that extract exactly the logic that was duplicated, not a new abstraction layer on top of
it.

Only `runItem()`, `appendReportBlock()`, and the `ReportTarget`/`RunItemOptions` types are exported —
everything else in this module (template substitution, tool-approval policy resolution, write-mode
application, and their supporting types) has no reader outside the file and is module-private (issue
#189).

## The pipeline

```ts
runItem(options: RunItemOptions): Promise<void>
```

1. **Substitute** — replaces `{{file}}` with the vault-relative file path in the prompt/instruction
   body.
2. **Run** — routes through `AgentService.inlineChat()`. Post-#220 (removal of the OpenAI-compatible
   provider matrix and its hand-rolled local ReAct loop) there is no separate local-model branch:
   a `model` the running `AgentService` classifies local (`isLocalModel()`) runs through the same
   CLI call as Claude, with `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` repointed at the configured
   local agent endpoint (issue #122) via `inlineChat()`'s own env handling — `runItem()` needs no
   routing logic of its own. `agent` has no current caller; `abortController`/`onEvent`
   are used by `batchLoopExecutor.ts` for cancellation and usage accumulation. Unused options are
   harmless no-ops, so this stays one call site.
3. **Apply write mode** — `applyWriteMode()`: `false`/`undefined` appends the result via the
   caller's `appendReport` callback; `true` replaces the target file's entire content (with an
   empty-response guard, and falling back to `appendReport` on a missing file or a write-back lock
   timeout); `'frontmatter'` merges the response (parsed as YAML) into the target file's
   frontmatter (falling back to `appendReport` the same way). No current caller sets anything but
   the default — `batchLoopExecutor.ts` always passes `undefined`, so it always takes the
   "append to report" branch.
4. **Append report** — not part of `runItem()` itself; `appendReport` is a callback the caller
   supplies, built on the shared `appendReportBlock()` primitive (below). This is deliberate:
   report *identity* (path, first-write heading) and *block formatting* are caller-specific.

`runItem()` does **not** catch execution errors: `batchLoopExecutor.ts` must distinguish a genuine
per-file failure from a mid-flight cancellation (`handle.stop()` aborting the in-flight query), so
the error is left to propagate and the caller decides.

## Report append primitive

```ts
interface ReportTarget {
  path: string;    // full vault-relative report file path
  heading: string;  // heading written once, on first create for the day
}

appendReportBlock(app: App, target: ReportTarget, block: string): Promise<void>
```

Create-or-append `block` to `target.path`: creates the file with `target.heading` if this is the
first entry written today, otherwise appends below the existing content (separated by a blank
line). Uses `vault.read()`/`vault.modify()` (not `adapter.read`/`write`) so the Obsidian cache and
internal file queue stay consistent, ensures `_synapse/reports/` exists first (via
`configWriter.ts`'s `ensureFolder()`), and wraps the whole read-modify-write in the per-path
advisory lock from [lock-manager.md](lock-manager.md) so concurrent appends to the same report file
(e.g. two concurrent batch loops) can't interleave and clobber each other.

`appendReportBlock()` does **not** catch `LockAcquisitionError` — `batchLoopExecutor.ts` lets it
propagate to the per-file loop body in `runBatchLoop()`, which already catches and reports per-file
failures, so a lock timeout there surfaces the same way an ordinary write failure would.

## Tool approval policy (issue #151)

Before this issue, the Claude branch (`executeWithClaude()`) always ran with `permissionMode:
'default'` and no `canUseTool` — in the Agent SDK, `'default'` means "ask", and with no callback
and no UI there is nobody to ask, so any approval-requiring tool call (`Write`, `Edit`, ...) was
silently refused. Read-only tools generally passed; the model's own text response is what
`applyWriteMode()` persists, so the common case (a run whose only job is to *report* on a file)
worked by coincidence — but a run whose prompt also asked the model to use a write tool would have
that call refused with nothing recorded anywhere.

The fix makes the mapping from `settings.toolApproval` to what the SDK is handed explicit:

```ts
type ToolApprovalPolicy = 'allow' | 'ask'; // module-private
resolveToolApprovalPolicy(plugin: SynapsePlugin): ToolApprovalPolicy // module-private
```

- **`'allow'`** (`settings.toolApproval === 'allow'`) → `permissionMode: 'bypassPermissions'` +
  `allowDangerouslySkipPermissions: true`. Matches the pattern already used by
  `editorMenu.ts`/`editModal.ts`/`searchPanel.ts` for the same setting's interactive surfaces.
- **`'ask'`** (the default) → `permissionMode: 'default'` plus a `canUseTool` that **denies every
  call it's invoked for** and records the tool name into an in-memory `refusals` list for that run.
  This is the asymmetry the issue calls out: in an interactive surface `'ask'` means "a human
  decides"; in an unattended run there is no human, so `'ask'` can only mean "deny" — but
  unlike before, the denial is no longer silent.

If `refusals` is non-empty after the run, `runItem()` appends a report block
(`formatToolRefusalsReportBlock()`) via the caller's `appendReport` — **unconditionally**,
regardless of `write` mode. This is deliberate: a `write: true`/`'frontmatter'` run's main result
goes to the target file/frontmatter, not the report, so without this the refusal would be invisible
again even though the main pipeline "worked". The report block is always appended in *addition* to
whatever `applyWriteMode()` already did, not instead of it.

**Post-#220, this policy applies uniformly.** There is no separate local-model branch left to carve
out an exception for: `resolveToolApprovalPolicy()`'s policy is handed to the single
`AgentService.inlineChat()` call regardless of whether `options.model` resolves to Claude or a
local agent endpoint (issue #122) model. (Historically, issue #142's "offer vault tools to a local
model with no approval handler" follow-up was deferred here because the pre-#220 local ReAct loop
had its own separate, unattended-by-default tool wiring; that loop is gone.)

**Telegram bot is a deliberate, separate exception**, not driven by this policy at all — see
"Tool approval policy — deliberately not `settings.toolApproval`" under
[bots.md](bots.md) and [SECURITY.md](../SECURITY.md) #1.

## Current status

Extracted from the (now-removed) trigger executor and `batchLoopExecutor.ts` in issue #154, after
#152 (executor tests) and #153 (`src/vaultPaths.ts`) landed. Issue #188 removed the trigger system
(`src/triggers.ts`, `src/triggerExecutor.ts`) entirely, leaving `batchLoopExecutor.ts` as this
module's only caller. Issue #189 then collapsed the trigger-shaped generality the pipeline had
carried since #154:

- The `surface: 'trigger' | 'batch-loop'` union (on `RunItemOptions` and
  `formatToolRefusalsReportBlock()`) is gone — the tool-refusal report hint always uses the single
  remaining wording ("Set Settings → Synapse → ..."), since there is no per-item frontmatter opt-in
  left to mention.
- `resolveToolApprovalPolicy()`'s `overrideAllow` parameter (a trigger's `toolApproval: allow`
  frontmatter opt-in, issue #151) is gone — it now only reads `settings.toolApproval`. This changes
  *wording*, never *whether* a refusal happens: the deny-and-log behavior for `'ask'` is unchanged.
- `substituteTemplates()`'s `{{files}}` alias (`aliasFiles`) is gone — it only ever existed for
  scheduled triggers with a `path` glob fanning out one call per matched file; `{{file}}` is the
  only substitution now.
- Report-collision handling is single-behavior: `batchLoopExecutor.ts` lets a
  `LockAcquisitionError` from `appendReportBlock()` propagate to its per-file loop body. (The
  removed trigger executor degraded differently — see git history if that's ever needed again.)
- The module's public surface shrank from 12 exports to 4 (`ReportTarget`, `appendReportBlock`,
  `RunItemOptions`, `runItem`) — everything else (template substitution, tool-approval types and
  `resolveToolApprovalPolicy()`/`formatToolRefusalsReportBlock()`, write-mode types and
  `applyWriteMode()`) had no reader outside this file and is now module-private.

`batchLoopExecutor.ts`'s public entry point (`runBatchLoop(plugin, filePaths, instruction, handle,
onProgress?, budget?)`) is unchanged by any of the above — this was a pure internal refactor of
`runExecutor.ts`, not a behavior change to batch loops.
