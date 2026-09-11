# settings

Source: `src/settings.ts` — settings interface, defaults, and the settings tab UI.

`SynapseSettingTab.display()` only builds the tab bar/panel scaffolding and dispatches
to one private `render*Panel(panel: HTMLElement)` method per tab — `renderClaudePanel`,
`renderAgentsPanel`, `renderCapabilitiesPanel`, `renderToolsPanel`, `renderBotsPanel`.
Per-tab state (e.g. `renderAuthFields`, the CLI-status renderer) lives as closures local to the
owning `render*Panel` method, same pattern as `renderBotsPanel`'s `updateConnectButton` — none of
it is shared across tabs, so nothing needed to become a class-level field.

## Groups

- **Claude** — authentication mode (Claude subscription OAuth or Anthropic API key), API key input (stored securely), CLI location override, resolved binary and version status display, and **Test** button.
- **Feature Map & Agents** — feature-to-agent map (`featureAgents`: `chat`, `inline`, `search`, `telegram`, `vision`), shipping methodology-tuned default agents (`General`, `Vision`, `Zettelkasten`, `PARA`, `LYT`), and per-agent model bindings. Model bindings for vault agents (`.agent.md`) can be edited directly in Settings, modifying the file frontmatter with zero local availability hard dependency.
- **Capabilities** — Hardcoded `_synapse/` folder (exported as `SYNAPSE_FOLDER` constant) and **Initialize** button (creates `_synapse/agents/` and `_synapse/skills/` with sample agents and skills). Also includes editor integration toggles (auto-update working directory, auto-include note images, and max note images), and, under "Chat run guardrails", opt-in interactive-loop thresholds: **Turn limit** (`loopTurnThreshold`), **Token budget** (`loopTokenThreshold`), and **Dollar budget (USD)** (`loopCostThresholdUsd`) — all default to `0` (off). See `chat-view.md` "Loop turn/cost thresholds" for enforcement details.
- **Tools** — tools approval mode (`ask` or `allow`).
- **Bots** — Telegram bot configuration (bot identifier, token stored via secure storage, allowed user IDs, and default agent picker).

## Feature Map & Agents

The **Feature Map & Agents** tab maps each core feature (`chat`, `inline`, `search`, `telegram`, `vision`) to a named agent persona loaded from vault or shipped defaults. Lightweight features default to `General` out of the box with zero required local setup. Vision-dependent features map to `Vision`.

Folder initialization creates five distinct agent files in `_synapse/agents/`:
- `general.agent.md`: General-purpose assistant for general chat, editing, and search.
- `vision.agent.md`: Vision-capable assistant for image and diagram analysis.
- `zettelkasten.agent.md`: Methodology assistant for atomic notes and dense linking.
- `para.agent.md`: Methodology assistant for Projects, Areas, Resources, and Archives.
- `lyt.agent.md`: Methodology assistant for Linking Your Thinking and Maps of Content (MOCs).

Per-agent model bindings: each vault agent's bound model (`model:` frontmatter property) is editable directly within the Settings tab. Changes immediately modify the underlying `.agent.md` file in the vault.

## Local agent endpoint

The Claude tab's **Local agent endpoint** section has two settings — **Endpoint URL**
(`localAgentEndpointUrl`) and **Endpoint API key** (`localAgentEndpointApiKey`, stored securely
like the other secrets) — plus a **Test** button. Setting a URL points local-model queries at
that endpoint via `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` (see `agent-service.md`'s
`buildEnv()`), so local models run through the same Agent SDK/CLI as Claude: full streaming, tool
use, skills, and permission modes.

Model discovery is `fetchEndpointModels({baseUrl, apiKey})` (`src/providerModels.ts`) — ONE
Obsidian `requestUrl()` GET to `<baseUrl>/v1/models`, with the same base-URL normalization and
blank-key→`'ollama'` rule as the Test probe below, mapping the OpenAI-shaped
`{data: [{id, ...}]}` catalogue to `ModelInfo[]`. `main.ts#initAgentService()` calls it whenever
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
  HTTP error or 200 in a non-Anthropic shape → `{ok: false}` naming the wrong-shape response; 200 +
  `{type: 'message'}` → `{ok: true, messageId}` → "Endpoint reachable — Messages API responded."
- **Timeout:** `requestUrl()` has no AbortSignal, so the probe is raced against a 10s
  `window.setTimeout` — a dead-but-accepting host can't hang the button.

## Invariants

- Secrets (tokens, password inputs) never land in `data.json`.
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



