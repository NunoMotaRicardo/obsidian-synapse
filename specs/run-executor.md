# run-executor

## Overview

`src/runExecutor.ts` is the per-item run pipeline behind "run a prompt against a file, then persist
the result": substitute template variables, run via `AgentService.inlineChat()`, apply a write
mode, append a report entry. It has **no in-tree caller** currently — kept as reusable,
self-contained run-pipeline infrastructure.

Only `runItem()`, `appendReportBlock()`, and the `ReportTarget`/`RunItemOptions` types are exported —
everything else in this module (template substitution, tool-approval policy resolution, write-mode
application, and their supporting types) has no reader outside the file and is module-private.


## The pipeline

```ts
runItem(options: RunItemOptions): Promise<void>
```

1. **Substitute** — replaces `{{file}}` with the vault-relative file path in the prompt/instruction
   body.
2. **Run** — routes through `AgentService.inlineChat()`. A `model` the running `AgentService`
   classifies local (`isLocalModel()`) runs through the same CLI call as Claude, with
   `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` repointed at the configured local agent endpoint via
   `inlineChat()`'s own env handling — `runItem()` needs no routing logic of its own. `agent` has
   no current caller; `abortController`/`onEvent` exist for a caller running many items in an
   abortable loop to wire up cancellation and usage accumulation. Unused options are harmless
   no-ops, so this stays one call site.
3. **Apply write mode** — `applyWriteMode()`: `false`/`undefined` appends the result via the
   caller's `appendReport` callback; `true` replaces the target file's entire content (with an
   empty-response guard, and falling back to `appendReport` on a missing file or a write-back lock
   timeout); `'frontmatter'` merges the response (parsed as YAML) into the target file's
   frontmatter (falling back to `appendReport` the same way). No current caller sets anything but
   the default, so this always takes the "append to report" branch.
4. **Append report** — not part of `runItem()` itself; `appendReport` is a callback the caller
   supplies, built on the shared `appendReportBlock()` primitive (below). This is deliberate:
   report *identity* (path, first-write heading) and *block formatting* are caller-specific.

`runItem()` does **not** catch execution errors: a caller running many items over an abortable loop
must be able to distinguish a genuine per-item failure from a mid-flight cancellation, so the error
is left to propagate and the caller decides.

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
can't interleave and clobber each other.

`appendReportBlock()` does **not** catch `LockAcquisitionError` — a caller running many items in a
loop lets it propagate to the per-item loop body, which already has to catch and report per-item
failures, so a lock timeout there surfaces the same way an ordinary write failure would.

## Tool approval policy

The mapping from `settings.toolApproval` to what the SDK is handed is explicit:

```ts
type ToolApprovalPolicy = 'allow' | 'ask'; // module-private
resolveToolApprovalPolicy(plugin: SynapsePlugin): ToolApprovalPolicy // module-private
```

- **`'allow'`** (`settings.toolApproval === 'allow'`) → `permissionMode: 'bypassPermissions'` +
  `allowDangerouslySkipPermissions: true`. Matches the pattern used by
  `editorMenu.ts`/`editModal.ts`/`searchPanel.ts` for the same setting's interactive surfaces.
- **`'ask'`** (the default) → `permissionMode: 'default'` plus a `canUseTool` that **denies every
  call it's invoked for** and records the tool name into an in-memory `refusals` list for that run.
  In an interactive surface `'ask'` means "a human decides"; in an unattended run there is no
  human, so `'ask'` can only mean "deny" — but the denial is explicit and recorded, not silent.

If `refusals` is non-empty after the run, `runItem()` appends a report block
(`formatToolRefusalsReportBlock()`) via the caller's `appendReport` — **unconditionally**,
regardless of `write` mode. This is deliberate: a `write: true`/`'frontmatter'` run's main result
goes to the target file/frontmatter, not the report, so without this the refusal would be invisible
even though the main pipeline "worked". The report block is always appended in *addition* to
whatever `applyWriteMode()` already did, not instead of it.

This policy applies uniformly to all model types: `resolveToolApprovalPolicy()`'s policy is handed
to the single `AgentService.inlineChat()` call regardless of whether `options.model` resolves to
Claude or a local agent endpoint model.

**Telegram bot is a deliberate, separate exception**, not driven by this policy at all — see
"Tool approval policy — deliberately not `settings.toolApproval`" under
[bots.md](bots.md) and [SECURITY.md](../SECURITY.md) #1.

