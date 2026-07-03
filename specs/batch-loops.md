# batch-loops

## Overview

Batch loops run a single, user-supplied prompt sequentially over a chosen set of vault files,
calling the configured agent once per file and recording results — a user-initiated,
plugin-orchestrated alternative to the autonomous batch/agentic loops other tools offer. Per
`wiki/decisions/2026-06-28-claude-agent-sdk-migration.md`, the plugin owns iteration and applies
caps; it never hands control of the loop itself to the model.

This is built on the foundational slice (issue #73) of the Tier-2 batch-loops feature (tracked by
#66), and adds budget-based cost caps and true in-flight cancellation (issue #74). Issue #75 adds a
dedicated progress modal that replaces the plain per-file `Notice`s with a live-updating view of
the run.

## Launch flow (`src/batchLoopExecutor.ts`)

Entry point: `launchBatchLoop(plugin: SynapsePlugin): void`, wired to the command palette entry
"Synapse: Run batch loop over notes" (`main.ts`, command id `run-batch-loop`).

1. Opens `VaultScopeModal` (`src/modals/vaultScopeModal.ts`, reused as-is) to let the user pick
   target files/folders via the same checkbox-tree UI used elsewhere for vault scope selection.
2. Resolves the picked paths (a mix of file paths, folder paths, or `'/'` for the whole vault)
   into a flat, de-duplicated, sorted list of vault-relative markdown file paths via
   `resolveScopeToFiles()`. Folders are expanded recursively; only `.md` files are included
   (matches the convention `configWriter.ts`'s `scanAgents`/`scanTriggers` use). Files under
   `_synapse/` are excluded from folder expansion (same feedback-loop rationale as
   `TriggerWatcher` — see [bots-triggers.md](bots-triggers.md)) unless explicitly hand-picked.
   An empty resolved scope (no markdown files, or nothing selected) cancels the run with a
   `Notice` rather than starting.
3. Opens `UserInputModal` (`src/modals/userInputModal.ts`, reused as-is) prompting for the
   instruction to run per file, telling the user how many files are in scope and that `{{file}}`
   is available for substitution. An empty/cancelled answer cancels the run with a `Notice`.
4. Prompts for an optional budget cap via `promptForBudget()` (also `UserInputModal`, reused): a
   max token count, a max dollar spend, or blank/`none`/`skip` for no cap (unlimited, the
   original #73 default). Free-text is parsed by `parseBudgetInput()` — `$5`, `$5.50`, `5
   dollars`, `5 usd` parse as a dollar budget; a bare number or `500000 tokens` parses as a token
   budget; unparseable non-empty input re-prompts (up to 3 attempts) rather than silently treating
   a typo as "no budget". After 3 failed attempts the run proceeds without a budget rather than
   blocking indefinitely.
5. Opens a `BatchLoopProgressModal` (`src/modals/batchLoopProgressModal.ts`, issue #75) tied to a
   `BatchLoopHandle`, then calls `runBatchLoop()` with the parsed budget, passing an `onProgress`
   callback that forwards each update to the modal. See **Progress UI** below.

## Core executor: `runBatchLoop()`

```ts
runBatchLoop(
  plugin: SynapsePlugin,
  filePaths: string[],
  instruction: string,
  handle: BatchLoopHandle,
  onProgress?: BatchLoopOnProgress,
  budget?: BatchLoopBudget,
): Promise<BatchLoopResult>

type BatchLoopOnProgress = (progress: BatchLoopProgress, usage: BatchLoopUsage) => void;
```

**File-count cap:** `BATCH_LOOP_MAX_FILES` (currently `50`, a plain exported constant — no
settings UI yet) is a hard ceiling. If `filePaths.length` exceeds it, the run does not start at
all: it reports the overage (files in scope vs. the limit, and how many would be skipped) via
`Notice` and returns `{processed: 0, failed: 0, skipped, cancelled: false, reason:
'scope-too-large'}`. This is a stop-early guard, not a "process the first N and skip the rest"
behavior — the user must narrow the selection and re-run.

**Sequential iteration:** files are processed one at a time, in the sorted order
`resolveScopeToFiles()` produced. Before each file (including the first), the loop checks, in
order: `handle.cancelled` (stops immediately if set, before starting that file), then whether the
cumulative `budget` (if any) has already been exceeded by prior files' usage (stops before
starting the next file — see **Budget enforcement** below). Either stop appends a run summary to
the report and reports processed vs. skipped via `Notice`.

**Per-file execution — `runOnFile()`:** mirrors `triggerExecutor.ts`'s Claude routing path
exactly: substitutes `{{file}}` in the instruction with the vault-relative path, then calls
`AgentService.inlineChat()` with `systemPrompt: {type: 'preset', preset: 'claude_code'}` (the
default tool-usage prompt, so the loop can read the substituted file path), `cwd` set to the
absolute vault base path and `plugins` set to
the `_synapse/` local plugin path (same SDK plugin-discovery wiring bots/triggers/editor actions
use), `maxTurns: 10`, `permissionMode: 'default'`. This always routes through Claude — local-model
routing (as `triggerExecutor.ts` has for triggers) remains out of scope. It also passes a
per-file `AbortController` (see **Cancellation** below) and an `onEvent` callback that forwards
each file's `SDKResultMessage` (`type: 'result'`) to the caller, which accumulates cumulative
token/cost usage for budget enforcement.

**Per-file progress:** the optional `onProgress` callback is invoked twice per file — once when the
file starts, with `{index, total, filePath, phase: 'starting'}` paired with cumulative usage
*before* that file's result comes back, and again immediately after the file's result arrives
(success path only — a failed file only gets the `'starting'` call), with
`{index, total, filePath, phase: 'done'}` paired with updated cumulative usage. The `phase` field
lets a caller distinguish the two calls without re-deriving it from `index` alone, since both
calls carry the same `index`/`total`/`filePath`. This lets a live progress UI
(`BatchLoopProgressModal`, #75) show "N/total processed" and elapsed budget without re-deriving
usage from `SDKResultMessage`s itself, and without changing the executor's core loop. The per-file
`Notice`s from #73/#74 have been removed now that the progress modal shows this live; the
completion `Notice` (see **Completion** below) is unaffected.

**Per-file error handling:** an error for one file is caught, logged via `console.error`, appended
to the report under a `### Error` heading, and does *not* abort the rest of the run — subsequent
files still run. The run's `failed` count reflects it and it's mentioned in the completion
`Notice`. The one exception is an `AbortError` raised by `handle.stop()` aborting the in-flight
query (see **Cancellation**) — that is treated as a cancellation, not a per-file failure, and
ends the run immediately rather than continuing to the next file.

**Completion:** once all files are processed (or the loop is cancelled/budget-exhausted), a
summary `Notice` is shown and a `BatchLoopResult` (`{processed, failed, skipped, cancelled,
reason}`) is returned. `reason` (`'completed' | 'cancelled' | 'budget-exceeded' |
'scope-too-large'`) records why the run ended.

## Budget enforcement (`BatchLoopBudget`)

```ts
type BatchLoopBudget =
  | {type: 'tokens'; max: number}
  | {type: 'dollars'; max: number};
```

An optional, user-configured cap on total spend for a single run — `undefined` means unlimited
(the original #73 behavior, unchanged when no budget is set).

- **Usage source:** each file's `SDKResultMessage.usage` (input, output, cache-creation, and
  cache-read token fields, summed) and `total_cost_usd` are accumulated into a running
  `BatchLoopUsage` (`{totalTokens, totalCostUsd}`) as results come back from `runOnFile()`'s
  `onEvent` forwarding — the same usage/cost data `AgentService` already surfaces for session
  tracking (`specs/agent-service.md`), not a separate estimate.
- **Check timing:** the budget is checked once per loop iteration, immediately after the
  cancellation check and *before* the next file starts (`budgetExceeded(usage, budget)`). A
  budget check never truncates a file mid-flight — the file whose result pushed cumulative usage
  over the cap is allowed to finish and is counted as processed; the *next* file is the one that
  doesn't start.
- **Parsing:** `parseBudgetInput()` (used by the launch flow) accepts `$5`/`$5.50`/`5
  dollars`/`5 usd` for a dollar budget, a bare number or `N tokens` for a token budget, and
  empty/`none`/`skip` for no budget; returns `null` for anything else so the launch flow can
  re-prompt instead of silently defaulting.

## Cancellation (`BatchLoopHandle`)

```ts
class BatchLoopHandle {
  cancelled: boolean;
  stop(): void;
  setActiveController(controller: AbortController | null): void;
}
```

`stop()` sets `cancelled = true` **and** aborts whichever `AbortController` the loop most recently
registered via `setActiveController()` — the loop creates one `AbortController` per file, passes
it to `runOnFile()` → `AgentService.inlineChat()` (which threads it into the SDK's
`sendAndWaitWithAbort()`, per `specs/agent-service.md` — no new cancellation mechanism was
introduced), and clears the registration once that file's call settles. So clicking "Stop":
- Between files: caught by the top-of-loop `handle.cancelled` check, same as before.
- While a file's `inlineChat()` call is in flight: aborts that call immediately via the SDK's
  existing abort machinery, rather than waiting for it to finish. The resulting abort is caught,
  recognized via `handle.cancelled` being `true`, and treated as a cancellation (not a per-file
  failure) — the in-progress file is *not* counted as processed.

Either path appends a run summary to the report (see below) recording files processed vs.
remaining and the cancellation reason, in addition to the completion `Notice`.

## Report format

Results are appended to `_synapse/reports/batch-loop-YYYY-MM-DD.md` — one file per day, shared
across all batch-loop runs that day (not one file per run). Created with a top-level heading if
absent for the day; each file processed appends a `## <vault-relative-path>` sub-heading followed
by the model's response (or, on error, `### Error` followed by the error message). If a run stops
early (budget exhaustion or cancellation), a `### Run summary` block is appended once, after the
last file-level entry for that run, via `appendRunSummary()`:

```
# batch-loop — YYYY-MM-DD

## notes/example.md

<model response>

## notes/other.md

### Error

<error message>

### Run summary

- Status: stopped — budget exhausted (limit: 500,000 tokens)
- Files processed: 3
- Files failed: 1
- Files skipped/remaining: 6
- Total files in scope: 10
- Cumulative usage: 512,340 tokens, $1.2345
```

`Status` reads one of: `stopped by user (cancelled)` or `stopped — budget exhausted (limit: ...)`
— these are the two early-stop reasons a run summary block is written for. The `scope-too-large`
stop is `Notice`-only: it happens before any file starts (and possibly before today's report file
even exists), so there is nothing to append — no run summary block is written for it. Completed
runs (`reason: 'completed'`) also do *not* get a run summary block — the per-file entries and
completion `Notice` are sufficient, matching #73's original behavior.

`_synapse/reports/` is created automatically if missing, via `configWriter.ts`'s `ensureFolder()`
(shared with other writers rather than duplicating trigger-executor's own folder-creation logic).
Appends use `vault.read()` + `vault.modify()` (not `adapter.read`/`write`) so the Obsidian cache
and internal file queue stay consistent — same rationale as `triggerExecutor.ts`'s
`appendToReport()`.

The whole read-modify-write in `appendBlockToReport()` is wrapped in the per-path advisory lock
from [lock-manager.md](lock-manager.md), keyed on the report path, so two batch-loop runs (or a
batch loop and a trigger) appending to the same day's report can't interleave and clobber each
other.

This report format is deliberately close to (but distinct from) the trigger executor's: triggers
key their report file by trigger name (`<trigger-name>-YYYY-MM-DD.md`) with one heading per day
and one result block per firing; batch loops key by the fixed name `batch-loop` and add a
per-file `##` sub-heading (and, on early stop, a `### Run summary`) within each day's file, since
a single run covers many files at once.

## Invariants

- All SDK access goes through `AgentService.inlineChat()` — no direct SDK imports in this module,
  per the architecture rule in `CLAUDE.md`/[agent-service.md](agent-service.md).
- The plugin, not the model, owns iteration: one `inlineChat()` call per file, no autonomous
  multi-file tool use handed to the model.
- `_synapse/` is excluded from recursive folder expansion to avoid the loop re-processing its own
  reports/agents/skills.
- The file-count cap is a hard stop-before-start guard, not a truncate-and-continue behavior.
- Cancellation aborts the current in-flight file's query (reusing `AgentService`'s existing
  `AbortController`/`sendAndWaitWithAbort` pattern — no parallel cancellation mechanism), not just
  the loop between files; an aborted in-progress file is not counted as processed.
- Budget checks happen between files, using cumulative usage from completed files' results — a
  budget never truncates a file mid-flight; the file that pushes usage over the cap still
  completes and counts as processed.
- One failing file does not abort the run; failures are recorded in the report and reflected in
  the run's `failed` count. An abort from `handle.stop()` is the one exception — it is treated as
  a cancellation, not a per-file failure, and ends the run.
- No budget set (`undefined`) means unlimited — unchanged from #73's original behavior.

## Current status

Core executor and launch command implemented (issue #73): command palette entry, scope/prompt
launch flow, sequential per-file execution via `AgentService.inlineChat()`, file-count cap,
per-file report appending, and progress `Notice`s.

Budget caps and true in-flight cancellation implemented (issue #74): optional launch-flow budget
prompt (`promptForBudget()`/`parseBudgetInput()`), cumulative usage/cost tracking from
`SDKResultMessage`, between-file budget enforcement, per-file `AbortController` threaded through
`BatchLoopHandle.stop()` for immediate in-flight cancellation, and `### Run summary` report
entries for both budget-triggered and user-cancelled early stops.

A dedicated progress modal implemented (issue #75): `BatchLoopProgressModal`
(`src/modals/batchLoopProgressModal.ts`) opens once the scope/instruction/budget prompts resolve
and stays open for the duration of the run, replacing the #73/#74 per-file `Notice`s. It shows:

- The current file being processed and "N/total processed", updated live via `onProgress`.
- Elapsed budget — "`<used>` / `<cap>` tokens" or "$`<used>` / $`<cap>`" — when a budget is set, or
  "no cap" when it isn't. Usage-so-far is threaded through `onProgress`'s new `BatchLoopUsage`
  parameter (see **Core executor** above) rather than tracked separately by the modal.
- A "Cancel" button wired directly to `handle.stop()` — the same cancellation path #74 introduced
  (in-flight abort via `BatchLoopHandle`'s registered `AbortController`, not just a between-files
  flag).
- On completion (any `BatchLoopResult.reason`), a final summary phrased consistently with the
  `### Run summary` report block: status, files processed/failed/skipped, and total files in
  scope. The modal stays open afterward with a "Close" button — it does not auto-close, so the
  user can read the summary at their own pace.

**Non-closing-doesn't-stop invariant (AC-5):** dismissing the modal any way other than the
"Cancel" button — the built-in `x`, Escape, or a backdrop click, all of which route through
Obsidian's `Modal.onClose()` — does not stop the loop. `onClose()` intentionally never calls
`handle.stop()`; only the "Cancel" button does. A loop dismissed this way keeps running in the
background and keeps appending to the report; there is no way to reopen its progress view for
that run (out of scope for this slice) — only the report file and the final completion `Notice`
remain as a record.
