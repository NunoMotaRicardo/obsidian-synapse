# Synapse Technical Implementation Guide

This document explains the technical implementation of the **Synapse** Obsidian plugin —
which packages are in use, what responsibility each one has, and how they fit into the plugin
architecture. It reflects the **Claude Agent SDK** codebase as of 2026-06-30.

> Previous versions of this guide described the upstream `@github/copilot-sdk` (Sidekick)
> codebase. That SDK was fully replaced in the migration documented at
> [`.docs/decisions/2026-06-28-claude-agent-sdk-migration.md`](../decisions/2026-06-28-claude-agent-sdk-migration.md).

---

## 1. High-level architecture

At runtime, Synapse is an Obsidian desktop plugin with a thin lifecycle layer and a thicker
application layer:

1. `src/main.ts` boots the plugin, loads settings, registers the sidebar view, editor
   integrations, Telegram bot, trigger watcher/scheduler, and the improve-synapse seed skill.
2. `src/synapseView.ts` is the main application controller for the sidebar UI. It coordinates
   chat state, model/agent/skill selection, session persistence, and search.
3. `src/copilot.ts` (`AgentService`) wraps `@anthropic-ai/claude-agent-sdk` and is the
   **sole** boundary between the plugin and Claude CLI / local model execution.
4. `src/view/sessionConfig.ts` maps Obsidian context (active note, vault scope, attachments,
   agent config) into SDK-ready query options.
5. `src/configWriter.ts` provides write-side utilities for the self-improve feature and
   first-run seeding of `_synapse/` artifacts.

In practical terms, the flow is:

```
Obsidian UI → SynapseView → sessionConfig → AgentService → @anthropic-ai/claude-agent-sdk → claude CLI
                                  ↑
                       configWriter (self-improve / seeding)
```

For local model paths (triggers, dynamic delegation):

```
TriggerExecutor → executeLocalProviderQuery (providerModels.ts) → OpenAI-compatible endpoint
                → McpBridgeSession (mcpBridge.ts) → stdio MCP servers
```

---

## 2. Runtime dependencies

The runtime dependency set is intentionally small.

### `obsidian`

The host API for the plugin. Almost every user-facing behavior depends on it.

Used for:

- Plugin lifecycle via `Plugin` in `src/main.ts`.
- Rendering views, modals, menus, settings, notices, and markdown UI across `src/synapseView.ts`,
  `src/settings.ts`, and `src/modals/*`.
- Vault access and file abstractions (`TFile`, `TFolder`, `normalizePath`) in
  `src/configWriter.ts`, `src/view/sessionConfig.ts`, and the editor/search features.
- Secure-ish vault-local storage for secrets via `app.loadLocalStorage` / `app.saveLocalStorage`
  in `src/settings.ts`.
- HTTP requests for Telegram integration via `requestUrl` in `src/bots/telegramApi.ts`.

### `@anthropic-ai/claude-agent-sdk`

The core AI integration library. `src/copilot.ts` is the only file in the plugin that imports
it directly (architecture rule from `AGENTS.md`).

Used for:

- `query()` — sends a prompt and streams SDK messages from the `claude` CLI subprocess.
- `listSessions()`, `deleteSession()`, `renameSession()` — session management.
- `tool()`, `createSdkMcpServer()` — for the dynamic delegation MCP tool (in-process).
- `startup()` — optional warm pre-spawn for faster first-query latency.
- Type re-exports: `Options`, `SDKMessage`, `AgentDefinition`, `CanUseTool`, `OnElicitation`, etc.

Important implementation detail:

`src/copilot.ts` (`AgentService`) adds Synapse-specific behavior on top of the SDK:

- Resolves the `claude` CLI binary (via `runtimeManager.ts`).
- Builds a sanitised subprocess environment (`cleanEnv()`).
- Implements `routeQueryOptions()` for agent-model binding and delegation server injection.
- Exposes high-level `chat()` / `inlineChat()` methods used by all plugin subsystems.

### `zod`

Used by `src/copilot.ts` to define the dynamic delegation MCP tool schemas
(`cheap_generate`, `bulk_summarize`). Bundled as a transitive SDK dependency.

---

## 3. Peer dependencies

These packages are required by the editor integration but not bundled — Obsidian provides
the editor runtime.

### `@codemirror/state` and `@codemirror/view`

Used in `src/editor/editorMenu.ts` to inspect and manipulate editor selections and transactions.
Marked as external in the esbuild config so the plugin reuses Obsidian's hosted versions.

---

## 4. Build and tooling dependencies

### `esbuild`

Configured in `esbuild.config.mjs`. Bundles `src/main.ts` and the TypeScript source tree into
a single `main.js` plugin file. Leaves `obsidian`, CodeMirror packages, Electron, and Node
built-ins as externals. Produces a watch mode for fast dev iteration.

### `typescript`

Used by the `build` script via `tsc -noEmit`. Type-checks the codebase in strict mode. Validates
interfaces between the Obsidian layer, the Agent SDK layer, and the config-driven features.

### `tsx`, `jiti`, `tslib`

Tooling dependencies for TypeScript execution and compilation support. Not part of the shipped
plugin runtime.

---

## 5. Linting dependencies

### `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-obsidianmd`

The lint stack runs via `npm run lint`. `eslint-plugin-obsidianmd` enforces Obsidian plugin
conventions. `@types/node` provides typings for Node.js APIs used in build scripts and the
desktop-only spawn/fs paths in `src/runtimeManager.ts` and `src/mcpBridge.ts`.

---

## 6. Why the dependency list is small

Most application logic is handwritten instead of delegated to framework libraries:

- The sidebar UI is built directly with Obsidian DOM helpers, not React or another UI framework.
- The vault customization model (`_synapse/`) is managed by simple frontmatter parsing and
  directory listing, not a configuration framework.
- The Claude Agent SDK is the sole AI runtime package; there is no legacy BYOK provider matrix.

This keeps the plugin easy to ship inside Obsidian, where bundle size, compatibility, and low
operational complexity matter.

---

## 7. Internal modules

### Bootstrapping and host integration — `src/main.ts`

- Load and save plugin settings.
- Register the view, commands, ribbon icon, editor extensions, and context menus.
- Initialise `AgentService`, `TelegramBotService`, `TriggerWatcher`, `TriggerScheduler`.
- Seed `_synapse/skills/improve-synapse/SKILL.md` on first run.

### AI transport — `src/copilot.ts` (`AgentService`)

- Primary packages: `@anthropic-ai/claude-agent-sdk`, Node built-ins (via `runtimeManager.ts`)
- Resolve the `claude` CLI binary. Build clean subprocess env. Manage abort/timeout.
- Expose `chat()` for stateful sessions and `inlineChat()` for ephemeral one-shot queries.
- Implement the dynamic delegation MCP server (`cheap_generate`, `bulk_summarize`).
- Re-export all SDK types so no other module imports the SDK directly.

### CLI resolution — `src/runtimeManager.ts`

- Pure Node.js (no SDK import). Resolves the `claude` binary in priority order: settings
  override → global npm → OS links (WinGet, `~/.claude/bin/`) → SDK fallback.
- `getCliVersion()` — spawn `claude --version` and extract semver.
- `cleanEnv()` — allowlisted subprocess environment (no Electron env leakage).

### Main application controller — `src/synapseView.ts`

- Primary package: `obsidian`, local application modules
- Maintain current chat session state.
- Coordinate agent/model/skill/tools selection and toolbar sync.
- Orchestrate chat send, search, session persistence (list, restore, rename, delete).

### Session preparation — `src/view/sessionConfig.ts`

- Turn active note, selected files, vault scope, and attachments into SDK-ready query options.
- Build the vault structure block and self-improve hint for the system prompt.
- Convert `ChatAttachment` items to SDK attachment format (on-disk files vs. clipboard blobs).

### Vault customization config — `src/configWriter.ts`

- Write-side utilities for the self-improve feature.
- `writeAgent`, `writeSkill`, `writeTrigger`, `modifyArtifact`, `deleteArtifact` — all produce
  SDK-native formats for `_synapse/` artifacts.
- `scanAgents`, `scanSkills`, `scanTriggers` — display-only scans for toolbar dropdowns.
- `scanVaultStructure` — top-level folder scan for system prompt context.
- `ensureImproveSynapseSkill` — seeds the starter skill on first run.

No `configLoader.ts` — it was deleted as part of the Agent SDK migration. The Claude CLI
discovers agents, skills, and MCP servers natively from `_synapse/` on every query.

### Provider models — `src/providerModels.ts`

- `fetchProviderModels()` — direct HTTP fetch to BYOK / local provider endpoints (`/v1/models`
  for OpenAI-compatible, `/api/tags` for Ollama). Used by the Settings Test button and
  `buildOnListModels()`.
- `executeLocalProviderQuery()` — one-shot OpenAI-compatible chat completion for local models
  (triggers, dynamic delegation). Includes a ReAct tool-calling loop.
- `isLocalBackendConfigured()`, `clearCachedDefaultModel()` — helpers for the delegation path.

### Triggers — `src/triggers.ts`, `src/triggerExecutor.ts`

- `TriggerWatcher` — vault event listeners (create/modify/delete/rename) matched against
  `_synapse/triggers/*.md` definitions, with 500ms per-file debounce.
- `TriggerScheduler` — 60-second interval cron tick, evaluates scheduled triggers.
- `TriggerExecutor.executeTrigger()` — runs matched trigger against the configured model
  (Claude via `inlineChat()` or local via `executeLocalProviderQuery()`), applies write modes
  (report-only / full-replace / frontmatter-merge).

### MCP bridge — `src/mcpBridge.ts`

- `McpBridgeSession` — spawns stdio MCP server processes, negotiates JSON-RPC 2.0 handshake,
  returns a flat `LocalTool[]` list for use in local-model ReAct loops.
- Used by `TriggerExecutor` when a trigger runs against a local model and MCP tools are needed.

### Editor augmentation — `src/editor/editorMenu.ts`

- Add Synapse actions to editor and file context menus (rewrite, proofread, structure, image
  extraction, chat with Synapse, etc.).
- Routes text actions through the `inline` feature agent, image actions through the `vision`
  feature agent, both via `AgentService.inlineChat()`.

### Bots — `src/bots/telegramBot.ts`, `src/bots/telegramApi.ts`

- Expose Synapse conversations through Telegram long-polling.
- Reuse the same agent/session model as the chat panel.
- Allowlist of numeric user IDs; one session per chat/topic; `/new` resets.

### Settings — `src/settings.ts`

- Settings interface (`SynapseSettings`), defaults, secure field helpers, and the settings tab UI.
- Groups: **Claude** (auth + CLI), **Feature Map & Agents** (feature→agent map, model bindings),
  **Capabilities** (Initialize button, editor toggles), **Tools** (approval mode, MCP inputs),
  **Bots** (Telegram), **Triggers** (list, enable/disable, last-fired).

---

## 8. External systems Synapse depends on

### Claude CLI (`claude`)

Synapse spawns the `claude` CLI as a subprocess on every query, managed by the Agent SDK. The
CLI must be installed on the system (via `npm install -g @anthropic-ai/claude-code`, WinGet, or
the Claude desktop app). Runtime-manager (`src/runtimeManager.ts`) resolves the binary; if none
is found, a platform-specific installation Notice is shown.

See [`.docs/decisions/2026-06-14-copilot-cli-runtime-manager.md`](../decisions/2026-06-14-copilot-cli-runtime-manager.md)
for the history of the resolution approach, and [`.docs/specs/runtime-manager.md`](../../specs/runtime-manager.md)
for the current spec.

### Local models (Ollama, Foundry Local, or any OpenAI-compatible endpoint)

Configured in Settings under the local provider preset. Used by the trigger executor and the
dynamic delegation MCP tool via `executeLocalProviderQuery()`. The MCP bridge adds tool-calling
capability to local models via stdio MCP servers configured in `_synapse/.mcp.json`.

### MCP servers

Configured by the user in `_synapse/.mcp.json`. The Claude Agent SDK discovers them natively for
Claude sessions. The MCP bridge spawns them directly for local-model trigger sessions.

### Vault-defined agents, skills, and triggers (`_synapse/`)

These are not code dependencies, but first-class runtime inputs. The `_synapse/` folder is
registered as an SDK local plugin on every session (`plugins: [{type: 'local', path: ...}]`),
so the CLI discovers agents, skills, and `.mcp.json` natively. Triggers are parsed and executed
by the plugin's own trigger system.

---

## 9. Practical summary

If you need the shortest accurate explanation of the package stack:

- `obsidian` gives Synapse its host environment, UI primitives, vault access, and plugin lifecycle.
- `@anthropic-ai/claude-agent-sdk` gives Synapse its Claude AI conversation, session, and MCP
  integration layer. The SDK spawns the `claude` CLI per query.
- `@codemirror/state` and `@codemirror/view` power the editor-specific inline editing features.
- `esbuild`, `typescript`, and the ESLint packages are the development toolchain.

Everything else in the repository is application code that composes those building blocks into
a configurable, automating AI assistant for Obsidian.