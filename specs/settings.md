# settings

Sources: `src/settings.ts` — settings interface, defaults, and the settings tab UI; `src/identityMigration.ts` — legacy secure local-storage migration.

`SynapseSettingTab.display()` only builds the tab bar/panel scaffolding and dispatches
to one private `render*Panel(panel: HTMLElement)` method per tab — `renderClaudePanel`,
`renderAgentsPanel`, `renderCapabilitiesPanel`, `renderToolsPanel`, `renderBotsPanel`.
Per-tab state (e.g. `renderAuthFields`, the CLI-status renderer) lives as closures local to the
owning `render*Panel` method, same pattern as `renderBotsPanel`'s `updateConnectButton` — none of
it is shared across tabs, so nothing needed to become a class-level field.

## Settings search exception

Obsidian 1.13's non-empty `getSettingDefinitions()` replaces `display()` entirely. This tab's
vault-dependent agent/model lists, asynchronous endpoint probe, and action buttons require the
stateful multi-panel renderer, so a partial declarative list would hide working controls. The
narrow `obsidianmd/settings-tab/prefer-setting-definitions` suppression for `src/settings.ts` is
intentional until the complete UI can be migrated without changing behavior.

## Groups

- **Claude** — authentication mode (Claude subscription OAuth or Anthropic API key), API key input (stored securely), CLI location override, resolved binary and version status display, and **Test** button.
- **Feature Map & Agents** — feature-to-agent map (`featureAgents`: `chat`, `inline`, `search`, `telegram`, `vision`), listing the agents discovered in `_synapse/agents/` (plus **Auto**, the empty value = SDK default agent), and per-agent model bindings. Model bindings for vault agents (`.md`, including `.agent.md`) can be edited directly in Settings, modifying the file frontmatter with zero local availability hard dependency.
- **Capabilities** — Hardcoded `_synapse/` folder (exported as `SYNAPSE_FOLDER` constant) and **Initialize** button (installs the starter kit via `installStarterKit()` — see `config-writer.md` "Starter kit"; never overwrites). Also includes editor integration toggles (auto-update working directory, auto-include note images, and max note images), and, under "Chat run guardrails", opt-in interactive-loop thresholds: **Turn limit** (`loopTurnThreshold`), **Token budget** (`loopTokenThreshold`), and **Dollar budget (USD)** (`loopCostThresholdUsd`) — all default to `0` (off). See `chat-view.md` "Loop turn/cost thresholds" for enforcement details.
- **Tools** — tools approval mode (`ask` or `allow`).
- **Bots** — Telegram bot configuration (bot identifier, token stored via secure storage, allowed user IDs, and default agent picker).

## Feature Map & Agents

The **Feature Map & Agents** tab maps each core feature (`chat`, `inline`, `search`, `telegram`, `vision`) to a named agent from `_synapse/agents/`. Every feature defaults to empty (**Auto**), which passes no `agent` to the SDK, so nothing depends on a particular agent file existing. The starter kit ships one agent, **Writer**.

Per-agent model bindings: each vault agent's bound model (`model:` frontmatter property) is editable directly within the Settings tab. Changes immediately modify the scanned agent's `filePath` in the vault through
`updateAgentModelFile()` / `updateAgentModelInContent()`. An empty value removes an existing model
line from frontmatter; a file without frontmatter receives a new (possibly empty) model field; this Settings write does not use `lockManager`.

## Local agent endpoint

The Claude tab's **Local agent endpoint** section has two settings — **Endpoint URL**
(`localAgentEndpointUrl`) and **Endpoint API key** (`localAgentEndpointApiKey`, stored securely
like the other secrets) — plus a **Test** button. Setting a URL points local-model queries at
that endpoint via `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` (see `agent-service.md`'s
`buildEnv()`), so local models run through the same Agent SDK/CLI as Claude: full streaming, tool
use, skills, and permission modes.

Model discovery is `fetchEndpointModels({baseUrl, apiKey})` (`src/providerModels.ts`) — ONE
Obsidian `requestUrl()` GET to `<baseUrl>/v1/models`, with the same base-URL normalization and
blank-key→`'ollama'` rule as the Test probe below, mapping `{data: [{id, ...}]}` or a bare array to `ModelInfo[]` with `id` and
`name` only. HTTP errors return `ok: false`; unparseable or unrecognized non-error
response shapes currently return `ok: true` with an empty list. No catalogue timeout is
implemented. Discovery in `main.ts` ignores failures and empty lists. `main.ts#initAgentService()` calls it whenever
`localAgentEndpointUrl` is set, and a successful result flows through `plugin.setProviderModels()`
→ `AgentService#setCustomModels()` → `plugin.notifySidebarModelsChanged()` →
`SynapseView#refreshProviderModels()`, populating the toolbar's model `<select>` alongside the
Claude models.

### Local agent endpoint Test button

The **Endpoint URL** setting has its own **Test** button, verifying the endpoint actually speaks
the Anthropic Messages API. A **blank endpoint URL** shows the guiding Notice "Endpoint URL is
empty — enter one above (default for Ollama: localhost:11434)." before the disable/`'Testing…'`
dance, performing no network request at all.

The probe itself is `testLocalAgentEndpoint({baseUrl, apiKey})` (`src/providerModels.ts`, next to
`fetchEndpointModels()`) — ONE Obsidian `requestUrl` POST to `<baseUrl>/v1/messages` with
Anthropic-protocol headers (`x-api-key`, `anthropic-version: 2023-06-01`) and a minimal 1-turn
user message with `max_tokens: 16`. It does not spawn the CLI and does not call `fetchModels()`;
it is read-only aside from the single probe request — no `saveSettings()`, no `initAgentService()`.

- **Base URL normalization**: trailing slashes and a trailing `/v1` are stripped before appending
  `/v1/messages` (or `/v1/models` for `fetchEndpointModels()`), so a pasted
  `http://localhost:11434/v1` probes the same path the agent path hits.
- **Credentials** use `buildEnv()`'s exact rule — a blank API key falls back to the literal
  `'ollama'` — so the probe validates the exact credentials the agent path will send.
- **Model independence:** the probe sends a fixed well-known model id and must **not** depend on
  it being installed. An endpoint that answers with an Anthropic error envelope
  (`{type: 'error', error: {...}}` — e.g. a 404 "model not found") has still proven the Messages
  API itself answered: that's `{ok: true, note}` — "Endpoint reachable — Messages API answered: …"
  carrying the endpoint's own error type/message — not a failure.
- **Outcome classification**: `requestUrl` rejecting (refused connection, DNS, TLS) →
  `{ok: false, isConnectionError: true}` with a "Could not connect to the endpoint …" message; an
  HTTP error or 200 in a non-Anthropic shape → `{ok: false}` naming the wrong-shape response; any HTTP status +
  `{type: 'message'}` → `{ok: true, messageId}` → "Endpoint reachable — Messages API responded."
- **Timeout:** `requestUrl()` has no AbortSignal, so the probe is raced against a 10s
  `window.setTimeout` — a dead-but-accepting host can't hang the button.

## Identity migration

The public manifest ID changes from `synapse` to `claude-synapse`, but secure settings retain
the same `synapse-secure-` logical keys. Obsidian's `App.loadLocalStorage()` and
`App.saveLocalStorage()` are vault-scoped, so the migration never enumerates raw browser storage
or accesses another vault's values. The historical `claude-brain-secure-` prefix is migrated
through those vault-scoped APIs only. Plugin settings in `data.json` remain compatible when users
move the old plugin folder to `plugins/claude-synapse/`; `_synapse/`, command IDs, view types,
and CSS namespaces are stable.

## Invariants

- Secret values live in vault-scoped App local storage (not encrypted by this module).
  `SECURE_FIELDS` contains `anthropicApiKey`, `telegramBotToken`, and
  `localAgentEndpointApiKey`; `saveSettings()` writes empty strings for these fields in
  `data.json`. Loading migrates legacy plaintext values when no non-empty stored value exists.
- `featureAgents` is merged separately with its defaults. Retired `providerPreset`,
  `providerBaseUrl`, `providerApiKey`, and `providerBearerToken` fields are explicitly stripped;
  a non-empty retired base URL causes a one-time migration Notice.
- `infiniteSessionsEnabled` defaults to `true` and is saved by the toolbar's Infinite sessions
  menu. It currently changes the badge and marks config dirty but is not consumed by query
  configuration; disabling it does not disable SDK compaction.
- `reasoningEffort: ''` means "model default" — never send the empty string to the SDK; the
  field is omitted from the session config instead.
- `SynapseSettings` has no `reasoningSummary`, `contextTier`, `synapseFolder`,
  `triggerLastFired`, or `inlineModel` fields. Old `data.json` files carrying these stale keys
  still load without error: `main.ts#loadSettings` merges persisted data over `DEFAULT_SETTINGS`
  via `Object.assign({}, DEFAULT_SETTINGS, raw)`, so stale keys ride along as harmless untyped
  properties rather than causing a load failure or wiping unrelated settings.
- The `SYNAPSE_FOLDER` constant from `src/vaultPaths.ts` is the single source of truth for the
  `_synapse/` path; settings.ts re-exports it for backward compatibility with importers.
- Settings changes that affect an active session mark the session config dirty; a new or
  reconfigured session picks them up.
- All local agent endpoint HTTP calls (the Test button, `main.ts#initAgentService()`'s discovery
  request) go through `fetchEndpointModels()`/`testLocalAgentEndpoint()` (`src/providerModels.ts`)
  — don't duplicate the `/v1/models`/`/v1/messages` fetch-and-parse logic inline in `settings.ts`
  or `main.ts`.



