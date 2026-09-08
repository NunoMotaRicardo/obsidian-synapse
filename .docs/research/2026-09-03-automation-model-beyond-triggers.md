# Beyond "triggers" — an automation model for Claude *and* Ollama

> Date: 2026-09-03 · Research report, no code changes.
> Question asked: the `_synapse/triggers/` folder is inherited Copilot vocabulary. What should the
> concept become, and which primitives — dispatch, hooks, loops — are actually usable on Claude and
> on Ollama?
>
> Verified against `@anthropic-ai/claude-agent-sdk@0.3.258`
> (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), the Ollama API docs, and the current
> `src/triggers.ts` / `src/triggerExecutor.ts` / `src/batchLoopExecutor.ts`.

---

## 0. The short answer

**Keep the mechanism. Replace the vocabulary. Split one overloaded concept into three honest ones.
And stop maintaining two execution engines.**

1. "Trigger" is doing three unrelated jobs at once (event-watch, cron-schedule, and one-shot
   batch). Rename the umbrella to **Automations**, and name the three kinds for what they are:
   **Watches**, **Schedules**, and **Batches**.
2. **SDK hooks are not a replacement for triggers** — this is the single most important finding.
   Hooks fire *inside* a running query. Triggers fire when *nothing is running*. They solve
   different problems and Synapse needs both. Adopting hooks lets you delete a lot of hand-rolled
   policy code; it does not let you delete the watcher or the scheduler.
3. "Dispatch" is not an SDK primitive. It is internal `agentService` vocabulary
   (`this.dispatch(event)` for session events, `agentService.ts:1168+`). No lead there.
4. **Ollama contributes nothing to the automation layer.** It is an inference server: no events,
   no scheduling, no hooks, no agent loop. Everything above the model call is, and must remain,
   Synapse's own.
5. Parity between Claude and Ollama should come from **one engine with two backends**, not two
   engines. Today Synapse has an SDK path and a hand-rolled ReAct path that diverge in capability
   at every call site. A local Anthropic-Messages-shaped proxy collapses them.

---

## 1. Why "trigger" is the wrong word

The folder and the type came across from the Copilot-era plugin. Three problems:

**It is Copilot/IDE-adjacent vocabulary.** In an Obsidian context, "trigger" reads like an editor
autocomplete trigger or a template trigger (Templater's `trigger` on file creation). In an
AI-plugin context it collides with prompt-injection "trigger phrases." It carries no signal about
*what happens when it fires*.

**It hides that these are agent runs.** A `_synapse/triggers/*.md` file is a prompt with routing
metadata, structurally identical to `_synapse/agents/*.md` and `_synapse/skills/*/SKILL.md`. Users
learning the customization model meet agents (who), skills (how), MCP servers (what with) — and
then "triggers" (…when? what?). The odd one out is a naming failure, not a conceptual one.

**One noun covers three behaviours.** Look at the actual code paths:

| In `TriggerConfig` | Fires from | Fans out | Has a target file | Implemented in |
|---|---|---|---|---|
| `event:` | Obsidian vault event | 1 execution | yes, the changed file | `TriggerWatcher` (`triggers.ts:206-397`) |
| `schedule:` + `path:` | 60s cron tick | N executions, one per glob match | yes, each match | `TriggerScheduler.fire` (`triggers.ts:465-476`) |
| `schedule:` no `path:` | 60s cron tick | 1 execution | **no** — `write` is force-disabled | `triggers.ts:479-484` |

…and then a *fourth* behaviour lives entirely outside the trigger system, in
`batchLoopExecutor.ts`: run one prompt over a user-chosen scope, with a budget and a progress
modal. It has its own report writer, its own date helper, its own model routing — a near-clone of
`triggerExecutor.ts` (see the code-quality report, §4).

Four behaviours, one noun for three of them, two implementations. That is the thing to fix.

---

## 2. What the Claude Agent SDK actually gives you

I read the shipped type definitions rather than relying on docs. The surface is much larger than
what Synapse currently uses.

### 2.1 Hooks — 33 events, in-session only

`HOOK_EVENTS` (`sdk.d.ts:854`) is 33 entries, passed as
`Options.hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>` (`sdk.d.ts:1595`). Each matcher
carries `matcher?: string`, `hooks: HookCallback[]`, `timeout?: number`. A callback returns either
`SyncHookJSONOutput` (`continue`, `decision: 'approve' | 'block'`, `systemMessage`, `stopReason`,
`hookSpecificOutput`) or `AsyncHookJSONOutput` (`{async: true, asyncTimeout?}`).

Grouped by what they would be *for* in Synapse:

| Group | Events | Synapse use |
|---|---|---|
| **Tool gating** | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionRequest`, `PermissionDenied` | Replace ad-hoc `canUseTool` plumbing; enforce "this automation may only write under `inbox/`"; log every tool call into the run report |
| **Turn lifecycle** | `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop` | Where the turn/token guardrails in `synapseView.checkLoopThresholds` belong |
| **Session lifecycle** | `SessionStart`, `SessionEnd`, `Setup`, `InstructionsLoaded`, `ConfigChange` | Inject vault context once; capture session ids for the sidebar |
| **Context** | `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch` | Note compaction in long automations; record model fallbacks in the report |
| **Workspace** | `FileChanged` (`{file_path, event: 'change' \| 'add' \| 'unlink'}`), `DirectoryAdded`, `CwdChanged`, `WorktreeCreate/Remove` | See the warning below |
| **Tasks/agents** | `TaskCreated`, `TaskCompleted`, `TeammateIdle` | Surface background subagent progress in the UI |
| **UX** | `Notification`, `MessageDisplay`, `Elicitation`, `ElicitationResult` | Already partly used via `onElicitation` |

**The `FileChanged` trap.** It is tempting to read `FileChanged` as "the SDK can do event triggers
for me." It cannot. `FileChanged` fires *during a live query*, when the CLI observes the filesystem
changing under an already-running session. It has no existence when no query is running — which is
precisely the state Synapse is in when a user saves a note. `TriggerWatcher`'s
`app.vault.on('create'|'modify'|'delete'|'rename')` remains the only correct source for
"something happened in the vault while nothing was running," and it is *better* than a filesystem
watcher because it is vault-aware (`TFile` instances, rename gives you `oldPath`).

Same for cron: nothing in the SDK schedules anything. The `'cron'` string that appears at
`sdk.d.ts:3815` is a **usage-telemetry behaviour label**, not a scheduling feature.

> **Rule of thumb:** the SDK governs what happens *inside* a run. Synapse governs *whether and when
> a run starts.* Hooks belong to the first; watchers and schedulers belong to the second, and stay
> owned by the plugin. Any design that tries to push scheduling into the SDK is a dead end.

### 2.2 Agent-level primitives Synapse is not using

From `AgentDefinition` (`sdk.d.ts:38-99`) — directly relevant to automations:

| Field | What it does | Why it matters here |
|---|---|---|
| `background?: boolean` | "Run this agent as a background task (non-blocking, fire-and-forget) when invoked" | An automation that shouldn't block the chat panel becomes a one-flag change instead of custom orchestration |
| `maxTurns?: number` | Per-agent turn cap | Today hardcoded `maxTurns: 10` in `triggerExecutor.ts:227` and `batchLoopExecutor.ts:255` |
| `effort?: 'low' \| … \| 'max' \| number` | Per-agent reasoning effort | A nightly digest can run cheap without a global settings change |
| `permissionMode?: PermissionMode` | Per-agent permission policy | **Directly fixes** the §3.4 defect in the code-quality report — the policy belongs on the agent, not hardcoded per call site |
| `memory?: 'user' \| 'project' \| 'local'` | Auto-loaded agent memory files | A recurring automation could accumulate state across runs instead of re-deriving it |
| `observer?: string` | Auto-spawns a read-only background observer agent that reports via `ObserverReport` | A supervisor for unattended runs — exactly the missing safety net for Telegram/cron execution |
| `initialPrompt?: string` | Auto-submitted first user turn | Could carry the `{{file}}` context |

Also available and unused: `Query.backgroundTasks(toolUseId?)` (`sdk.d.ts:2901`) to background an
in-flight run, and `SDKBackgroundTasksChangedMessage` (`:3346`) as a level signal of what's running
— which is the correct way to drive a "3 automations running" indicator, since it carries replace
semantics rather than edge bookends you can lose.

### 2.3 "Loops"

There is no SDK loop primitive, and there shouldn't be. What exists:

- **The agentic loop** — inside one `query()`, bounded by `maxTurns`. Already used.
- **Subagents / the Task tool** — fan-out within a run. `AgentInfo`, `background`, `observer`.
- **Workflows** — a real CLI/SDK feature (`disableWorkflows`, `workflowSizeGuideline`,
  `workflow_name` on tasks, `sdk.d.ts:5187, 6158-6178`), but it is a *coding* feature: Claude
  authoring multi-agent plans. Not a fit for vault automation, and gated by plan/config. Note it,
  don't build on it.
- **Plugin-orchestrated iteration** — Synapse's own `batchLoopExecutor`. This is the correct place
  for "run over 50 notes," and it should stay in the plugin.

So "loops" in the user-facing sense = **Batches**, owned by Synapse. Keep it, rename it, and merge
its plumbing with the other automations.

---

## 3. What Ollama gives you

Blunt answer: **inference, and nothing above it.**

| Capability | Ollama | Usable for automation? |
|---|---|---|
| Chat completion (`/api/chat`, `/v1/chat/completions`) | yes | The model call only |
| Tool calling (`tools` array → `tool_calls`) | yes, on tool-capable models; capability discoverable via `/api/show` `capabilities` | Yes — this is what makes the ReAct loop in `providerModels.ts` possible |
| Structured outputs (`format` = JSON Schema) | yes locally; **not on Ollama Cloud** | **Unused today and worth adopting** — see §6 |
| Vision | yes on vision models, via `images: string[]` on the message | Already handled (`providerModels.ts:290-310`) |
| Model listing / capabilities (`/api/tags`, `/api/show`) | yes | Already used |
| Embeddings (`/api/embed`) | yes | Unused; relevant to semantic search, not automation |
| **Events / file watching** | **no** | — |
| **Scheduling / cron** | **no** | — |
| **Hooks / interception** | **no** | — |
| **Agent loop, subagents, permissions, sessions** | **no** | — |
| **MCP** | **no** (Ollama is not an MCP client) | Synapse bridges this itself in `mcpBridge.ts` |

This is the crux. Every one of Synapse's automation questions — when to fire, what to allow, when
to stop, where to write — is answered by **plugin code plus the Agent SDK**. Ollama answers exactly
one question: what the next assistant message is. Any design that hopes for symmetry between
"Claude features" and "Ollama features" at the automation layer is asking the wrong question.

The right question is: **how does an Ollama-backed automation get the same agentic capability an
Anthropic-backed one gets?**

---

## 4. One engine, two backends

Today Synapse runs two execution engines that diverge badly:

| | Claude path | Local path |
|---|---|---|
| Entry | `AgentService.inlineChat()` → `query()` → CLI | `executeLocalProviderQuery()` (`providerModels.ts:245-450`) |
| Loop | Full agentic loop | Hand-rolled ReAct, `maxTurns` default 5 |
| Tools | Every CLI tool, MCP servers, skills, subagents | `vaultTools` (3 tools) + MCP-bridged tools — **but only in `triggerExecutor`**; `inlineChat`'s local branch (`agentService.ts:752-771`) passes none |
| Permissions | `permissionMode`, `canUseTool`, hooks | none |
| Sessions / resume | yes | `local-${Date.now()}`, no continuity |
| Skills, agents, `_synapse/` plugin | yes, natively | no |
| Streaming | yes | no |
| Cost/turn accounting | `SDKResultMessage.usage` | none |

So "this automation runs on Ollama" silently means "this automation loses skills, subagents,
permissions, sessions, streaming and accounting." That is not a model choice, it is a different
product — and nothing in the UI says so.

### The fix: point the Claude CLI at a local model through a translating proxy

`ANTHROPIC_BASE_URL` redirects all Claude Code traffic to any endpoint speaking the **Anthropic
Messages API** (`/v1/messages`). A local gateway — LiteLLM is the common one — accepts Messages-API
requests and translates them to whatever the upstream wants, including Ollama. Result: the *same*
`query()` call, the *same* hooks, skills, subagents, permission modes and session resume, with a
local model doing the inference.

Two things follow immediately:

1. **`agentService.buildEnv(forLocalModel = true)` is already half of this — and it is wrong.**
   It sets `ANTHROPIC_BASE_URL` to Ollama's `/v1`, which is OpenAI-shaped, not Messages-shaped. It
   is dead code (no caller passes `true`), so nothing is broken today, but it must not be revived
   as-is. It needs to point at a Messages-API gateway, and the setting must be labelled as such.
2. **The hand-rolled ReAct loop stops being the primary local path** and becomes the
   *no-dependencies fallback*: direct Ollama for people who won't run a proxy, explicitly documented
   as the reduced-capability tier.

Proposed local-model tiering, made visible in the UI:

| Tier | Setup | Capability |
|---|---|---|
| **Direct** | Ollama base URL only | One-shot or short ReAct with vault + MCP tools. No skills, agents, sessions, permissions. Today's behaviour. |
| **Gateway** | Ollama + a Messages-API proxy URL | Full Agent SDK: skills, subagents, hooks, permissions, sessions, streaming. Everything Claude automations get. |

That is the honest answer to "support both Claude and Ollama": not feature parity by
reimplementation, but *one* engine that both can drive, with a clearly-labelled degraded tier for
the zero-setup case.

---

## 5. Proposed model: Automations

### 5.1 Vocabulary

Retire `triggers`. Introduce **Automations** as the umbrella, with three kinds:

| Kind | Fires when | Replaces | Owner |
|---|---|---|---|
| **Watch** | A vault event matches a path glob | `event:` triggers | `TriggerWatcher` → `WatchRunner` |
| **Schedule** | A cron expression matches | `schedule:` triggers | `TriggerScheduler` → `ScheduleRunner` |
| **Batch** | The user launches it over a chosen scope | batch loops | `batchLoopExecutor` |

All three are the same thing with a different *ignition source*: **a prompt, a model/agent binding,
a scope, an output policy, and a budget.** That shared shape is the argument for one executor.

And separately — not as a kind of automation, but as a property of any run:

| **Hooks** | In-run policy: what the agent may do, when to stop, what gets logged. Declared once, applied to every automation. |

This vocabulary is also honest about provenance: Watch/Schedule/Batch are Synapse concepts; Hooks
are the SDK's, and calling them by the SDK's name means users can read Anthropic's docs directly.

### 5.2 Folder layout

```
_synapse/
  agents/         *.md            (unchanged)
  skills/         <name>/SKILL.md (unchanged)
  automations/    <name>.md       ← replaces triggers/
  hooks/          <name>.md       ← new, optional
  reports/        <name>-YYYY-MM-DD.md
  .mcp.json
```

`automations/*.md` frontmatter, with the trigger fields carried over so migration is mechanical:

```yaml
name: inbox-triage
description: File and tag anything dropped in the inbox
on: watch                 # watch | schedule | batch
event: file-created       # watch only
path: "inbox/*.md"        # glob — scope for all three kinds
schedule: "0 9 * * *"     # schedule only
agent: Librarian
model: sonnet             # or a local id; see the Direct/Gateway tiers
output: report            # report | replace | frontmatter | append   (was `write`)
budget: 200000 tokens     # reuses budget.ts parsing — new for watch/schedule
maxTurns: 10
permissions: inherit      # inherit | ask | allow   (was implicit and inconsistent)
enabled: true
```

Changes worth calling out:

- **`on:`** makes the kind explicit instead of inferring it from which of `event`/`schedule` is
  present. The current mutual-exclusion validation (`bots-triggers.md`) becomes unnecessary.
- **`output:`** replaces `write: false | true | 'frontmatter'`, whose truthiness reads backwards
  (`write: false` doesn't mean "no output," it means "write to a report"). Add `append` — appending
  to the target note is the single most-requested shape this model can't currently express.
- **`budget:`** extends the existing `budget.ts` parser to unattended runs. Right now only batch
  loops have a spend cap; a runaway cron trigger has none. That is a real risk to fix before this
  is public.
- **`permissions:`** makes the §3.4 inconsistency (default/no-callback for triggers,
  bypass for Telegram, settings-driven for editor actions) an explicit, per-automation choice.

`hooks/*.md` — thin declarative wrappers over the SDK events, so a user can write a guardrail
without writing TypeScript:

```yaml
name: never-touch-archive
event: PreToolUse
matcher: "Write|Edit"
---
Deny any tool call whose path is under archive/. Reply with a one-line reason.
```

Start with a tiny allowlist of events — `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop` — and
grow only on demand. The full 33 are available if needed later.

### 5.3 What Claude vs Ollama can actually do, per kind

| | Claude (SDK) | Ollama — Gateway tier | Ollama — Direct tier |
|---|---|---|---|
| Watch fires | ✅ plugin-owned | ✅ plugin-owned | ✅ plugin-owned |
| Schedule fires | ✅ plugin-owned | ✅ plugin-owned | ✅ plugin-owned |
| Batch runs | ✅ plugin-owned | ✅ plugin-owned | ✅ plugin-owned |
| Agentic loop | ✅ | ✅ | ⚠️ hand-rolled ReAct |
| `_synapse` skills & agents | ✅ | ✅ | ❌ |
| Subagents / `background` / `observer` | ✅ | ✅ | ❌ |
| Hooks (`hooks/*.md`) | ✅ | ✅ | ❌ |
| Permission modes | ✅ | ✅ | ❌ (no tool gate at all) |
| MCP tools | ✅ native | ✅ native | ⚠️ via `mcpBridge` |
| Session resume | ✅ | ✅ | ❌ |
| Token/cost accounting → budget | ✅ | ✅ | ❌ |
| Structured output | ✅ | ✅ | ✅ (Ollama `format`, unused today) |

Every ❌ in the last column is a consequence of the second engine, not of Ollama. That is the case
for §4.

---

## 6. Two capabilities worth adopting regardless

**Ollama structured outputs.** `format` accepts a JSON Schema. `applyWriteMode`'s
`'frontmatter'` branch currently does something fragile: it takes free-text model output, wraps it
in `---` fences, and re-parses it as YAML (`triggerExecutor.ts:283-292`). With `format` on Ollama
and structured outputs on the Claude side, an automation declaring `output: frontmatter` can demand
a typed object and get one. Removes a whole class of "the model wrote prose instead of YAML" bugs.
Caveat: not supported on Ollama Cloud models, so keep the fence-parse as a fallback.

**The `observer` agent.** For unattended runs — cron automations and the Telegram bot, both of
which run without a human watching — `AgentDefinition.observer` auto-spawns a read-only background
agent receiving activity digests. That is a supervisor for exactly the two surfaces that currently
have the weakest oversight and the strongest permissions.

---

## 7. Migration

Deliberately boring, because users have working trigger files.

1. **Ship the executor merge first** (code-quality report §4). A single `runExecutor` behind
   Watch/Schedule/Batch. No user-visible change.
2. **Add `_synapse/automations/`**, scanned alongside `_synapse/triggers/`. Accept both schemas:
   `on:` when present, otherwise infer from `event:`/`schedule:` exactly as today. Accept `write:`
   as an alias for `output:` with the current value mapping.
3. **Rename the settings tab** Triggers → Automations. Add a one-click "Migrate triggers" button
   that rewrites files into the new folder and schema — `configWriter.ts` already has the
   write-side helpers.
4. **Deprecate**: `_synapse/triggers/` keeps working, logs a one-time notice, and the docs stop
   mentioning it. Remove it a couple of minor versions later.
5. **Then** add what the new model unlocks: `budget:`, `permissions:`, `output: append`,
   `hooks/*.md`, and the Gateway tier.

Do not skip step 1. Adding a fourth ignition source to three duplicated executors is how this
becomes unmaintainable in public.

---

## 8. Open questions

- **Does the Gateway tier belong in Synapse at all, or just in the docs?** Requiring users to run
  LiteLLM is real friction. A middle path: detect a Messages-API-shaped endpoint on the configured
  base URL and light up the Gateway tier automatically, documenting the proxy setup in the wiki
  rather than shipping or supervising one.
- **Should Watches be able to fire on frontmatter change specifically**, not just any `modify`?
  Obsidian's `metadataCache.on('changed')` gives this, and it is the difference between a useful
  and a noisy tagging automation. Cheap to add, worth scoping.
- **Concurrency policy across automations.** `lockManager` serialises *writes*, but nothing bounds
  *how many automations run at once*. A cron automation with a broad `path:` glob fans out one run
  per matching file (`triggers.ts:465-476`) with no cap — 400 notes means 400 concurrent agent runs.
  Whatever the vocabulary ends up being, this needs a queue with a concurrency limit before the
  repo is public.
- **Where do budgets aggregate?** Per-run, per-automation-per-day, or a global daily cap? A global
  cap is the one users will actually ask for.

---

## Related

- [`2026-09-03-provider-matrix.md`](2026-09-03-provider-matrix.md) — the Direct/Gateway tiering and
  which presets survive.
- [`2026-09-03-open-source-readiness-code-quality.md`](2026-09-03-open-source-readiness-code-quality.md)
  — §4 is the prerequisite refactor for all of this.
- [`../specs/bots-triggers.md`](../../specs/bots-triggers.md) — current behaviour (note: partly stale).
- [`../specs/batch-loops.md`](../../specs/batch-loops.md) — the fourth behaviour.
- [`../decisions/2026-06-29-native-sdk-customization-model.md`](../decisions/2026-06-29-native-sdk-customization-model.md)
  — deferred triggers with the note "SDK hooks ≠ cron/glob background tasks." Still correct, and
  §2.1 above is the detailed evidence for why.

## Sources

- [Ollama API reference](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [Ollama — structured outputs](https://docs.ollama.com/capabilities/structured-outputs)
- [LiteLLM — use Claude Code with non-Anthropic models](https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models)
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (v0.3.258) — hooks, agent definitions,
  background tasks
