# batch-loops

## Overview

Batch loops run a single, user-supplied prompt sequentially over a chosen set of vault files,
calling the configured agent once per file and recording results — a user-initiated,
plugin-orchestrated alternative to the autonomous batch/agentic loops other tools offer. Per
`wiki/decisions/2026-06-28-claude-agent-sdk-migration.md`, the plugin owns iteration and applies
caps; it never hands control of the loop itself to the model.

This is the foundational slice (issue #73) of the Tier-2 batch-loops feature (tracked by #66).
Later slices add budget-based cost caps and richer in-flight cancellation (#74) and a dedicated
progress UI (#75) — this slice intentionally keeps the executor's surface small but leaves
extension points (a per-file progress hook, a cooperative cancellation handle) for those slices
to build on without a rewrite.

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
4. Shows a persistent (`duration: 0`) `Notice` containing a "Stop" button (built via the global
   `createFragment()` helper) tied to a `BatchLoopHandle`, then calls `runBatchLoop()`. The notice
   is hidden once the run finishes, regardless of outcome.

## Core executor: `runBatchLoop()`

```ts
runBatchLoop(
  plugin: SynapsePlugin,
  filePaths: string[],
  instruction: string,
  handle: BatchLoopHandle,
  onProgress?: (progress: BatchLoopProgress) => void,
): Promise<BatchLoopResult>
```

**File-count cap:** `BATCH_LOOP_MAX_FILES` (currently `50`, a plain exported constant — no
settings UI yet) is a hard ceiling. If `filePaths.length` exceeds it, the run does not start at
all: it reports the overage (files in scope vs. the limit, and how many would be skipped) via
`Notice` and returns `{processed: 0, failed: 0, skipped, cancelled: false}`. This is a stop-early
guard, not a "process the first N and skip the rest" behavior — the user must narrow the
selection and re-run.

**Sequential iteration:** files are processed one at a time, in the sorted order
`resolveScopeToFiles()` produced. Before each file (including the first), the loop checks
`handle.cancelled`; if set, it stops immediately (before starting that file, never mid-file) and
reports how many files were processed vs. skipped via `Notice`.

**Per-file execution — `runOnFile()`:** mirrors `triggerExecutor.ts`'s Claude routing path
exactly: substitutes `{{file}}` in the instruction with the vault-relative path, then calls
`AgentService.inlineChat()` with `systemPrompt: {type: 'preset', preset: 'claude_code'}` (the
default tool-usage prompt, so the loop can read the substituted file path), `cwd` set to the
absolute vault base path and `plugins` set to
the `_synapse/` local plugin path (same SDK plugin-discovery wiring bots/triggers/editor actions
use), `maxTurns: 10`, `permissionMode: 'default'`. This slice always routes through Claude —
local-model routing (as `triggerExecutor.ts` has for triggers) is out of scope for #73.

**Per-file progress:** after each file starts, a `Notice` is shown ("Synapse: processing N/total:
`<file>`") and the optional `onProgress` callback is invoked with `{index, total, filePath}`. This
hook exists so a future progress UI (#75) can subscribe without changing the executor's core
loop — it is not otherwise used in this slice.

**Per-file error handling:** an error for one file is caught, logged via `console.error`, appended
to the report under a `### Error` heading, and does *not* abort the rest of the run — subsequent
files still run. The run's `failed` count reflects it and it's mentioned in the completion
`Notice`.

**Completion:** once all files are processed (or the loop is cancelled), a summary `Notice` is
shown and a `BatchLoopResult` (`{processed, failed, skipped, cancelled}`) is returned.

## Cancellation (`BatchLoopHandle`)

```ts
class BatchLoopHandle {
  cancelled: boolean;
  stop(): void;
}
```

A minimal mutable handle: `stop()` sets `cancelled = true`. Cancellation is **cooperative** —
checked only between files, never mid-flight — so clicking "Stop" while a file's `inlineChat()`
call is in progress lets that call finish before halting. This slice does not abort in-flight SDK
calls; true in-flight cancellation (aborting the current file's query) is deferred to #74.

## Report format

Results are appended to `_synapse/reports/batch-loop-YYYY-MM-DD.md` — one file per day, shared
across all batch-loop runs that day (not one file per run). Created with a top-level heading if
absent for the day; each file processed appends a `## <vault-relative-path>` sub-heading followed
by the model's response (or, on error, `### Error` followed by the error message):

```
# batch-loop — YYYY-MM-DD

## notes/example.md

<model response>

## notes/other.md

### Error

<error message>
```

`_synapse/reports/` is created automatically if missing, via `configWriter.ts`'s `ensureFolder()`
(shared with other writers rather than duplicating trigger-executor's own folder-creation logic).
Appends use `vault.read()` + `vault.modify()` (not `adapter.read`/`write`) so the Obsidian cache
and internal file queue stay consistent — same rationale as `triggerExecutor.ts`'s
`appendToReport()`.

This report format is deliberately close to (but distinct from) the trigger executor's: triggers
key their report file by trigger name (`<trigger-name>-YYYY-MM-DD.md`) with one heading per day
and one result block per firing; batch loops key by the fixed name `batch-loop` and add a
per-file `##` sub-heading within each day's file, since a single run covers many files at once.

## Invariants

- All SDK access goes through `AgentService.inlineChat()` — no direct SDK imports in this module,
  per the architecture rule in `CLAUDE.md`/[agent-service.md](agent-service.md).
- The plugin, not the model, owns iteration: one `inlineChat()` call per file, no autonomous
  multi-file tool use handed to the model.
- `_synapse/` is excluded from recursive folder expansion to avoid the loop re-processing its own
  reports/agents/skills.
- The file-count cap is a hard stop-before-start guard, not a truncate-and-continue behavior.
- Cancellation is cooperative and file-granular, not mid-file.
- One failing file does not abort the run; failures are recorded in the report and reflected in
  the run's `failed` count.

## Current status

Core executor and launch command implemented (issue #73): command palette entry, scope/prompt
launch flow, sequential per-file execution via `AgentService.inlineChat()`, file-count cap,
cooperative Stop-notice cancellation, per-file report appending, and progress `Notice`s.

Budget-based cost caps and richer in-flight cancellation are tracked separately (#74). A
dedicated progress UI (replacing the plain per-file `Notice`s) is tracked separately (#75).
