# run-executor

## Overview

`src/runExecutor.ts` is the shared per-item run pipeline behind "run a prompt against a file, then
persist the result" surfaces. Before issue #154 it had two independent implementations — the
(now-removed) trigger executor and the batch loop executor ([batch-loops.md](batch-loops.md)) —
duplicating the same five steps: substitute template variables, route Claude vs. a local model,
run, apply a write mode, append a report entry, with only incidental differences in report
formatting and which optional features (local-model routing, budgets) each surface exposed. This
module owns that pipeline; `batchLoopExecutor.ts` is a thin caller that supplies what's actually
different: which file(s) to run over, where the prompt body comes from, how a report block is
formatted, and budget/cancellation/progress orchestration across many items.

**Issue #188 removed the trigger system** (`src/triggers.ts`, `src/triggerExecutor.ts`) —
`batchLoopExecutor.ts` is now this module's only caller. The trigger-shaped generality described
below (`aliasFiles`/`{{files}}`, the `surface: 'trigger' | 'batch-loop'` union, per-item
`toolApproval` override, write modes as a "trigger-only concept") is unreachable dead weight left
deliberately untouched for the follow-up, issue #189, rather than mixed into this removal — see the
epic (#187) for why. Treat the trigger-specific detail in this doc as historical until #189 either
collapses or repurposes it.

Model for this extraction: `src/budget.ts` (#74) and `src/vaultPaths.ts` (#153) — small, focused
modules that extract exactly the logic that was duplicated, not a new abstraction layer on top of
it.

## The pipeline

```ts
runItem(options: RunItemOptions): Promise<void>
```

1. **Substitute** — `substituteTemplates(body, filePath, {aliasFiles?})` replaces `{{file}}` (and,
   when `aliasFiles: true`, `{{files}}` as an alias) with the vault-relative file path.
   `aliasFiles` is trigger-only (`{{files}}` was never a documented batch-loop variable, and
   substituting a second pattern there would be a silent behavior change for any instruction that
   happens to contain the literal text `{{files}}` — see the module doc comment).
2. **Route** — if `options.model` names a model the running `AgentService` reports as local
   (`plugin.agentService.isLocalModel(model)`), routes to `executeLocalProviderQuery()` (with the
   target file's content prepended as context, and vault/MCP tools attached if the model supports
   tool calling); otherwise routes to `AgentService.inlineChat()`. Local-model routing is
   trigger-only — batch loops never pass a `model`, so they never select this branch (unchanged
   from #73's original scope decision).
3. **Run** — executes the routed call. `agent` (Claude-only), `abortController`, and `onEvent` are
   each meaningful to only one caller (`agent` — triggers; `abortController`/`onEvent` — batch
   loops, for cancellation and usage accumulation) but harmless no-ops for the other, so this is
   one shared call site rather than two near-identical ones.
4. **Apply write mode** — `applyWriteMode()`: `false`/`undefined` appends the result via the
   caller's `appendReport` callback; `true` replaces the target file's entire content (with an
   empty-response guard, and falling back to `appendReport` on a missing file or a write-back lock
   timeout); `'frontmatter'` merges the response (parsed as YAML) into the target file's
   frontmatter (falling back to `appendReport` the same way). Write modes are a trigger-only
   concept (`TriggerConfig.write`) — batch loops always pass `undefined`, so they always take the
   default "append to report" branch.
5. **Append report** — not part of `runItem()` itself; `appendReport` is a callback each caller
   supplies, built on the shared `appendReportBlock()` primitive (below). This is deliberate:
   report *identity* (path, first-write heading) and *block formatting* (a bare result for
   triggers vs. a `## <filePath>` sub-heading for batch loops, whose report is shared across many
   files in one run) are the one genuinely caller-specific piece of the pipeline.

`runItem()` does **not** catch execution errors — this was a deliberate two-caller design
(`triggerExecutor.ts` always converted a failure into a report entry; `batchLoopExecutor.ts` must
first distinguish a genuine per-file failure from a mid-flight cancellation, i.e. `handle.stop()`
aborting the in-flight query). With the trigger caller removed (#188), only the batch-loop
distinction still applies, but the error is still left to propagate rather than caught here.

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
(two batch-loop runs) can't interleave and clobber each other.

`appendReportBlock()` does **not** catch `LockAcquisitionError` — that degrade-or-propagate
decision is caller-specific and stays in the caller's own `appendReport` wrapper:

- `batchLoopExecutor.ts` lets it propagate — the per-file loop body in `runBatchLoop()` already
  catches and reports per-file failures, so a lock timeout there surfaces the same way an ordinary
  write failure would.
- (Historical: `triggerExecutor.ts`, removed in #188, caught it and degraded gracefully —
  `console.warn`, drops the entry — so a wedged holder couldn't block `executeTrigger()` forever.)

## Tool approval policy (issue #151)

Before this issue, the Claude branch (`executeWithClaude()`) always ran with `permissionMode:
'default'` and no `canUseTool` — in the Agent SDK, `'default'` means "ask", and with no callback
and no UI there is nobody to ask, so any approval-requiring tool call (`Write`, `Edit`, ...) was
silently refused. Read-only tools generally passed; the model's own text response is what
`applyWriteMode()` persists, so the common case (a trigger whose only job is to *report* on a
file) worked by coincidence — but a trigger whose prompt also asked the model to use a write tool
would have that call refused with nothing recorded anywhere. Batch loops had the identical gap.

The fix makes the mapping from `settings.toolApproval` to what the SDK is handed explicit and
shared by both callers:

```ts
type ToolApprovalPolicy = 'allow' | 'ask';
resolveToolApprovalPolicy(plugin: SynapsePlugin, overrideAllow?: boolean): ToolApprovalPolicy
```

- **`'allow'`** (global `settings.toolApproval === 'allow'`, or a trigger's own `toolApproval:
  allow` frontmatter opt-in) → `permissionMode: 'bypassPermissions'` +
  `allowDangerouslySkipPermissions: true`. Matches the pattern already used by
  `editorMenu.ts`/`editModal.ts`/`searchPanel.ts` for the same setting's interactive surfaces.
- **`'ask'`** (the default) → `permissionMode: 'default'` plus a `canUseTool` that **denies every
  call it's invoked for** and records the tool name into an in-memory `refusals` list for that run.
  This is the asymmetry the issue calls out: in an interactive surface `'ask'` means "a human
  decides"; in an unattended run there is no human, so `'ask'` can only mean "deny" — but
  unlike before, the denial is no longer silent.

If `refusals` is non-empty after the run, `runItem()` appends a report block
(`formatToolRefusalsReportBlock()`) via the caller's `appendReport` — **unconditionally**,
regardless of `write` mode. This is deliberate: a `write: true`/`'frontmatter'` trigger's main
result goes to the target file/frontmatter, not the report, so without this the refusal would be
invisible again even though the main pipeline "worked". The report block is always appended in
*addition* to whatever `applyWriteMode()` already did, not instead of it.

**Per-item opt-in, no reverse override (historical).** `resolveToolApprovalPolicy()`'s
`overrideAllow` parameter existed for a trigger's frontmatter `toolApproval: allow`
(`TriggerConfig.toolApproval`, round-tripped by `scanTriggers()`/`writeTrigger()`), which escalated
just that trigger to `'allow'` even when the global setting was `'ask'`. Triggers are gone (#188);
batch loops have no per-run config surface equivalent, so they always pass `undefined` and follow
the global setting directly. `overrideAllow` itself is left in place pending #189's cleanup of this
module's now-single-caller shape.

**Local-model routing is out of scope, deliberately.** `executeWithLocalModel()` /
`executeLocalProviderQuery()` are unchanged by this issue — offering vault tools to a local model
with no approval handler at all (unattended-by-default) is issue #142's follow-up, referenced but
explicitly deferred by #151's issue body. `routeAndRun()`'s `policy` parameter therefore only
affects the Claude branch.

**Telegram bot is a deliberate, separate exception**, not driven by this policy at all — see
"Tool approval policy — deliberately not `settings.toolApproval`" under
[bots.md](bots.md) and [SECURITY.md](../../SECURITY.md) #1.

## Budget/turn-cap divergence — historical

`batchLoopExecutor.ts` enforces an optional per-run budget (`budget.ts`'s `Budget`/`BudgetUsage`,
checked between files); the now-removed trigger executor enforced none. At the time (#154 through
#188) this was a deliberate, stated exemption rather than an oversight: a batch-loop budget is a
per-run, human-authorized safety cap over a known, finite set of files, whereas a trigger was a
standing, event-driven configuration with no single "run" to attach a cumulative cap to. With
triggers removed (#188) the divergence no longer applies — `runItem()`'s only caller,
`batchLoopExecutor.ts`, always enforces its budget.

## Current status

Extracted from the trigger executor and `batchLoopExecutor.ts` in issue #154, after #152 (executor
tests) and #153 (`src/vaultPaths.ts`) landed. Issue #188 removed the trigger executor and its
tests entirely; `batchLoopExecutor.ts`'s public entry point (`runBatchLoop(plugin, filePaths,
instruction, handle, onProgress?, budget?)`) is unchanged. The trigger-shaped generality this
module still carries (see "Overview") is left for issue #189.
