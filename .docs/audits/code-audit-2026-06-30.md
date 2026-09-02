# Code Audit — Synapse Plugin (2026-06-30)

> Produced by synapse-analyst + synapse-technical-planner after a full review of `src/`, `specs/`
> (now `.docs/specs/`), `wiki/`, and GitHub issues on `NunoMotaRicardo/obsidian-claude-brain`. Scope: consistency
> check, completeness assessment, and prioritised recommendations.

---

## 1. Implementation status

### What is fully built

The Claude Agent SDK migration epic (#1) is **substantially complete**. All foundation and
core feature sub-issues are closed:

| Done | Issue | Feature |
|---|---|---|
| ✅ | #2 | Feasibility spike |
| ✅ | #3 | Engine swap (Claude Agent SDK, dual auth) |
| ✅ | #4 | Runtime-manager rebase (claude binary resolution) |
| ✅ | #5 | Named agents + model binding + routing layer |
| ✅ | #6 | Settings feature→agent map + default agents |
| ✅ | #7 | Local-model backend (OpenAI-compatible) + capability detection |
| ✅ | #8 | Dynamic delegation: cheap/local agent as an MCP tool |
| ✅ | #9 | Active request cancellation |
| ✅ | #10 | Adaptive timeouts |
| ✅ | #11 | Remove ghost text |
| ✅ | #12 | Re-home editor/image actions onto handler/vision agents |
| ✅ | #13 | Customization re-base onto native Agent SDK |
| ✅ | #25–#30 | Self-improve system (config writer, vault scanner, seeding) |
| ✅ | #37–#41 | Folder hardcoding, configLoader deletion, native plugin registration |
| ✅ | #48–#52 | Trigger system (parser, event watcher, scheduler, executor, settings UI) |
| ✅ | #57–#58 | Local model ReAct loop (vault tools + MCP bridge) |

### What remains open (legitimately)

| Open | Issue | Status |
|---|---|---|
| 🔵 | #1 | Epic tracker — stays open until all children close |
| 📋 | #14 | Loop features (tier-2 batch loops + tier-1 Claude loops) — backlog, design-ready |
| 📋 | #15 | Cloud/remote sessions — backlog, deferred |
| 📋 | #47 | Local model tool-calling loop (MCP + ReAct) — backlog |

> **Note on #47:** May already be substantially addressed by the MCP bridge (#58) and ReAct
> loop (#57). The only gap explicitly described in #47 that is not in the trigger executor is
> "chat panel streaming." A targeted review of `src/mcpBridge.ts` and `src/triggerExecutor.ts`
> against the #47 acceptance criteria should clarify whether #47 can be closed or scoped down.

---

## 2. Consistency findings

### 2.1 Spec inconsistencies

#### `.docs/specs/copilot-service.md` — stale language throughout

The spec still uses Copilot SDK terminology in several sections even though the codebase has
fully migrated to `@anthropic-ai/claude-agent-sdk`. Specific issues:

- **Module name mismatch** — header says "copilot-service" but `src/copilot.ts` exports
  `AgentService`, not `CopilotService`. The architecture table in `00-architecture.md` uses
  "agent-service" correctly; the spec itself does not.
- **§ "SDK 1.0 contract (post-migration)"** — references `RuntimeConnection.forStdio`,
  `gitHubToken`, `getState()`, `ConnectionState`, `ping()`, `session.getEvents()` — all
  Copilot SDK concepts. The Claude Agent SDK uses `query()` with
  `pathToClaudeCodeExecutable`, no persistent connection, no `ping()`.
- **§ "BYOK provider injection (#25)"** — references `CopilotService`, `SidekickPlugin`,
  `sidekickView.ts` (old names). Current names: `AgentService`, `SynapsePlugin`, `synapseView.ts`.
- **§ "Version info callback (#15)"** — issue #15 is now the "Cloud/remote sessions" backlog
  item; the version info callback is its own concern. The `client.getStatus()` pattern described
  is Copilot SDK; the real implementation uses `getCliVersion()` from `runtimeManager.ts`.
- **§ "Ollama UX polish (#30)"** — references `src/ollamaErrors.ts` which does not appear in
  the current codebase `src/` directory. Ollama error handling is likely inline in
  `synapseView.ts` (which is 36KB).
- **§ "Invariants"** — says "No other module imports `@github/copilot-sdk` directly" — should
  read `@anthropic-ai/claude-agent-sdk`.

#### `.docs/specs/chat-view.md` — wrong source file name

The header lists `src/sidekickView.ts` as the panel shell source. The file is now
`src/synapseView.ts`.

#### `.docs/specs/settings.md` — minor staleness

- § "Feature Map & Agents (Issue #6)" says "shipped default agents in `claude-brain/agents/`"
  — should be `_synapse/agents/`.
- References to `populateModelSelect()` in `src/view/configToolbar.ts` as "Phase 2" — the
  phasing language is stale; it is simply "not yet built."
- The `github` preset Test button section references `copilot.ping()` — there is no longer a
  `ping()` method; the Copilot SDK is gone.

### 2.2 Wiki inconsistencies

#### `wiki/technical-implementation-guide.md` — **severely stale** (pre-migration)

This is the highest-priority wiki update. The guide still describes the **Copilot SDK codebase**:

- Title: "Sidekick Technical Implementation Guide" (plugin is now named Synapse)
- §1 references `src/configLoader.ts` (deleted), `@github/copilot-sdk` (removed), `CopilotClient`
- §2 devotes an entire section to `@github/copilot-sdk` as the "core AI integration library"
- §5 lists `@github/copilot-sdk` in the practical summary
- §7 lists `src/configLoader.ts` as a module; describes `.agent.md`, `.prompt.md`, `.trigger.md`
- §8 "External systems" still references the Copilot CLI and `sidekick/tools/mcp.json`
- §9 summary says the only AI package is `@github/copilot-sdk`

A reader of this guide today would get a completely wrong mental model of the codebase.

#### `wiki/ai-customization-guide.md` — **severely stale** (pre-migration)

- Title: "Obsidian Sidekick: GitHub Copilot Customization Guide"
- §1 describes `sidekick/` folder layout with `*.agent.md`, `*.prompt.md`, `*.trigger.md`
- §2 references `@github/copilot-sdk`, `configLoader.ts`, `sidekick/` folder
- Compatibility matrix compares against GitHub Copilot features — entirely obsolete framing
- Does not mention `_synapse/`, native SDK discovery, or the Agent SDK at all

The canonical reference for the new model is
`wiki/decisions/2026-06-29-native-sdk-customization-model.md`. The guide needs a full rewrite.

#### `wiki/domain-context-and-agent-delegation-prd.md` — stale layout references

- §3 "Goals": "Preserve compatibility with `sidekick/agents`, `sidekick/prompts`, `sidekick/skills`,
  `sidekick/tools`, and `sidekick/triggers` layout" — these paths no longer exist.
- §8 "File Format Details" references `sidekick/domains/` — the folder prefix is now `_synapse/`.
- §9 "Implementation Notes" references `loadDomains` alongside `loadAgents`/`loadSkills`
  from `configLoader.ts`, which has been deleted.
- Acceptance criteria §12.6 says "existing agents, prompts, skills, triggers, and MCP config
  continue to work without modification" — correct in spirit but file paths changed.

The PRD's core ideas (domain packs, agent delegation) are still valid future work, but
implementation assumptions need updating against the native SDK model.

#### `wiki/spike-claude-agent-sdk.md` — historical, acceptable

References SDK version "0.3.195" and pre-GA types. This is a historical spike document;
no action required unless the wiki gets a living-docs sweep.

### 2.3 Stale cross-reference in migration decision

`wiki/decisions/2026-06-28-claude-agent-sdk-migration.md` § "Related" says:

> `.claude/skills/copilot-sdk-reference/` — to be superseded by a Claude-Agent-SDK reference
> once the migration is planned.

The Claude Agent SDK reference skill now exists at `.claude/skills/claude-agent-sdk-reference/`.
This note should be updated to reflect the completed migration.

### 2.4 `SynapseSettings.synapseFolder` dead field

`src/settings.ts` still contains `synapseFolder: string` in the settings interface. The spec
(`config-loader.md`) correctly notes "its value is ignored — all code uses the constant."
The field persists in `data.json` but no UI control renders it. Keep for data compatibility;
mark with `@deprecated` JSDoc. No code change needed.

---

## 3. Business findings and recommendations

### 3.1 Strategic position: table stakes are done, differentiators are backlog

The current build delivers:

- Claude-native chat panel (sessions, search, image attachments, reasoning controls)
- Full editor integration (context menus, vision actions, image extraction)
- Telegram bot front-end
- Vault automation (triggers: event + cron, local + Claude, write modes, reports)
- Local model ReAct loop with vault tools + MCP bridge
- Self-improve (natural-language creation of `_synapse/` agents, skills, triggers)

What **differentiates** the plugin per `wiki/competitor-landscape.md` — loop features (#14) —
is still in the backlog. The competitor analysis explicitly states that "plain chat/edit plugins
plateau; the auto-organize + loops angle is what earns mindshare." The current build is
competitive table stakes; the differentiating value is not yet shipped.

**Recommendation:** Prioritise #14 (loop features) as the next major milestone.

### 3.2 Self-improve is built but undiscoverable

The self-improve system is fully implemented and operational. However:

- `wiki/ai-customization-guide.md` still describes the old Copilot model — users reading the
  wiki cannot discover or use the self-improve feature correctly from docs.
- `buildSelfImproveHint()` mentions "agent" and "skill" as artifact types but omits "trigger",
  which is now fully implemented in the codebase.

**Recommendations:**
1. Rewrite `wiki/ai-customization-guide.md` (high priority).
2. Update `buildSelfImproveHint()` in `sessionConfig.ts` to re-add "trigger" as a supported
   artifact type.

### 3.3 Local model ReAct + MCP bridge is undocumented

Issues #57–#58 are closed and the code is live, but there is no wiki entry explaining how the
local model ReAct loop + MCP bridge works for users. This is a power feature requiring
user-visible docs: how to configure `_synapse/.mcp.json`, which local models support tools,
what vault tools (`read_note`, `list_notes`, `search_notes`) are built-in.

**Recommendation:** Add `wiki/local-model-react-guide.md`.

### 3.4 Plugin name / rebrand is still unresolved

Internally the plugin is "Synapse" (class `SynapsePlugin`, view `SynapseView`, folder
`_synapse/`). The `manifest.json` and `README.md` may still carry old naming. This affects
discoverability ahead of any community release.

**Recommendation:** Audit `manifest.json`, `README.md`, and `package.json` for name consistency
before the first public release.

---

## 4. Technical findings and recommendations

### 4.1 `src/ollamaErrors.ts` referenced in spec but absent from codebase

`.docs/specs/copilot-service.md` §"Ollama UX polish (#30)" references `src/ollamaErrors.ts`
providing `friendlyOllamaError()`, `isToolUseError()`, etc. This file does not appear in the
current `src/` directory. Ollama error handling is most likely implemented inline inside
`synapseView.ts` (36KB).

**Recommendation:** Confirm. If inline, update the spec to name the actual file. If missing,
remove the section from the spec.

### 4.2 `.docs/specs/copilot-service.md` describes Copilot SDK architecture, not Agent SDK

This is the most stale spec in the codebase. The Agent SDK's `query()` model (stateless
per-query, no persistent connection, `pathToClaudeCodeExecutable`, no `ping()`) differs
substantially from what the spec describes. A synapse-coder working from this spec would build
the wrong thing.

**Priority: HIGH.** The spec is the contract for implementers.

### 4.3 Issue #47 may already be satisfied by closed issues

Issue #47 ("Local model tool-calling loop (MCP + ReAct)") is open and backlog-labelled. The
trigger executor (#51, closed) + MCP bridge (#58, closed) together implement exactly this: a
local model with MCP tools in a ReAct loop. The only gap #47 explicitly describes that is not
in the trigger executor is "chat panel streaming." Verify before creating new work.

### 4.4 No automated test suite

There are no automated tests (`test/` directory absent, no test runner in `package.json`). For
a plugin with complex state machines (session lifecycle, trigger scheduler, MCP bridge
handshake, glob matching, cron parsing), this is a growing risk.

**Recommendation:** Add `test/` with at minimum:

- Unit tests for `matchGlob()` (trigger path matching)
- Unit tests for cron expression parsing in `TriggerScheduler`
- Unit tests for `resolveDefaultCliPath()` resolution chain
- Unit tests for `buildSelfImproveHint()` / `buildVaultContextBlock()`

These are pure functions with no Obsidian or SDK dependencies — testable with `node:test` or
Vitest with zero extra infrastructure.

### 4.5 `vaultTools.ts` and `tasks.ts` are undocumented

`src/vaultTools.ts` (built-in vault tools: `read_note`, `list_notes`, `search_notes`) and
`src/tasks.ts` (TASKS constant) have no spec entries. `vaultTools.ts` is a user-facing
capability surface; users need to know what tools local models have access to.

**Recommendation:** Document vault tools in `.docs/specs/bots-triggers.md` (extend the "Trigger
executor" section) or in the new `wiki/local-model-react-guide.md`.

### 4.6 `debug.ts` is a micro-module with no spec coverage

`src/debug.ts` (487 bytes) exists but has no spec coverage. If it is a live utility, add a
note to the architecture table. If it is dead code, delete it.

---

## 5. Prioritised next actions

| Priority | Action | Effort |
|---|---|---|
| 🔴 High | Rewrite `wiki/technical-implementation-guide.md` (Synapse / Agent SDK) | 1–2 h |
| 🔴 High | Rewrite `wiki/ai-customization-guide.md` (`_synapse/` native model) | 2 h |
| 🔴 High | Update `.docs/specs/copilot-service.md` to reflect `AgentService` / Agent SDK | 1 h |
| 🟡 Med | Add `wiki/local-model-react-guide.md` (MCP bridge + vault tools) | 1 h |
| 🟡 Med | Audit #47 vs trigger executor + MCP bridge; close or narrow scope | 30 m |
| 🟡 Med | Update `buildSelfImproveHint()` to mention "trigger" as artifact type | 30 m |
| 🟡 Med | Fix migration decision cross-ref to `claude-agent-sdk-reference` skill | 15 m |
| 🟡 Med | Update domain-context PRD layout references (`sidekick/` → `_synapse/`) | 30 m |
| 🟢 Low | Start test suite with pure-function unit tests | 2 h |
| 🟢 Low | Name/rebrand audit (`manifest.json`, `README.md`, `package.json`) | 30 m |

---

## 6. File review table

| File | Status |
|---|---|
| `src/copilot.ts` | ✅ Good — clean `AgentService`, SDK isolation intact |
| `src/runtimeManager.ts` | ✅ Good — matches spec |
| `src/settings.ts` | ✅ Good — `synapseFolder` dead field harmless |
| `src/main.ts` | ✅ Good — lifecycle only, no business logic |
| `src/triggers.ts` | ✅ Good — `TriggerWatcher` + `TriggerScheduler` implemented |
| `src/triggerExecutor.ts` | ✅ Good — matches bots-triggers spec |
| `src/mcpBridge.ts` | ✅ Good — matches mcp-bridge spec |
| `src/vaultTools.ts` | ⚠️ No spec coverage — document |
| `src/debug.ts` | ⚠️ No spec coverage — verify it's alive |
| `.docs/architecture.md` | ✅ Good — accurate module table |
| `.docs/specs/copilot-service.md` | ❌ Stale — Copilot SDK language, wrong module name |
| `.docs/specs/chat-view.md` | ⚠️ Minor — wrong source filename (`sidekickView.ts` → `synapseView.ts`) |
| `.docs/specs/settings.md` | ⚠️ Minor — `github` preset section outdated, stale path reference |
| `.docs/specs/bots-triggers.md` | ✅ Good — trigger status section current |
| `.docs/specs/runtime-manager.md` | ✅ Good — accurate |
| `.docs/specs/config-writer.md` | ✅ Good — accurately reflects config-writer role |
| `.docs/specs/mcp-bridge.md` | ✅ Good — accurate |
| `.docs/specs/editor.md` | ✅ Good — accurate |
| `wiki/technical-implementation-guide.md` | ❌ Severely stale — pre-migration content |
| `wiki/ai-customization-guide.md` | ❌ Severely stale — Copilot SDK framing throughout |
| `wiki/competitor-landscape.md` | ✅ Good — current |
| `wiki/domain-context-and-agent-delegation-prd.md` | ⚠️ Stale layout references (`sidekick/`) |
| `wiki/spike-claude-agent-sdk.md` | ℹ️ Historical — acceptable |
| `wiki/decisions/2026-06-28-claude-agent-sdk-migration.md` | ⚠️ One stale cross-ref |
| `wiki/decisions/2026-06-29-native-sdk-customization-model.md` | ✅ Good — accurate |
