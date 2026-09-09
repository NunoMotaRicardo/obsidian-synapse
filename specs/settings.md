# settings

Source: `src/settings.ts` — settings interface, defaults, and the settings tab UI.

`SynapseSettingTab.display()` (issue #149) only builds the tab bar/panel scaffolding and dispatches
to one private `render*Panel(panel: HTMLElement)` method per tab — `renderClaudePanel`,
`renderAgentsPanel`, `renderCapabilitiesPanel`, `renderToolsPanel`, `renderBotsPanel` (the
**Triggers** tab and its `renderTriggersPanel` were removed in #188 along with the rest of the
trigger system).
Per-tab state (e.g. `renderAuthFields`, the CLI-status renderer) lives as closures local to the
owning `render*Panel` method, same pattern as `renderBotsPanel`'s `updateConnectButton` — none of
it is shared across tabs, so nothing needed to become a class-level field.

## Groups

- **Claude** — authentication mode (Claude subscription OAuth or Anthropic API key), API key input (stored securely), CLI location override, resolved binary and version status display, and **Test** button.
- **Feature Map & Agents** (replaces legacy Models tab) — feature-to-agent map (`featureAgents`: `chat`, `inline`, `search`, `telegram`, `vision`), shipping methodology-tuned default agents (`General`, `Vision`, `Zettelkasten`, `PARA`, `LYT`), and per-agent model bindings. Model bindings for vault agents (`.agent.md`) can be edited directly in Settings, modifying the file frontmatter with zero local availability hard dependency.
- **Capabilities** — Hardcoded `_synapse/` folder (exported as `SYNAPSE_FOLDER` constant) and **Initialize** button (creates `_synapse/agents/` and `_synapse/skills/` with sample agents and skills). Also includes editor integration toggles (auto-update working directory, auto-include note images, and max note images), and, under "Chat run guardrails" (issue #88), opt-in interactive-loop thresholds: **Turn limit** (`loopTurnThreshold`), **Token budget** (`loopTokenThreshold`), and **Dollar budget (USD)** (`loopCostThresholdUsd`) — all default to `0` (off). See `chat-view.md` "Loop turn/cost thresholds" for enforcement details. All code uses the `SYNAPSE_FOLDER` constant (`src/vaultPaths.ts`) directly; see the `synapseFolder` removal note under Invariants (issue #148).
- **Tools** — tools approval mode (`ask` or `allow`).
- **Bots** — Telegram bot configuration (bot identifier, token stored via secure storage, allowed user IDs, and default agent picker).

## Feature Map & Agents (Issue #6)

The **Feature Map & Agents** tab replaces the former Models tab:
- **Feature -> Agent map**: Allows mapping each core feature (`chat`, `inline`, `search`, `telegram`, `vision`) to a named agent persona loaded from vault or shipped defaults. Lightweight features default to `General` (or a Claude model backend) out of the box with zero required local setup. Vision-dependent features map to `Vision`.
- **Shipped Default & Methodology Agents**: Folder initialization creates five distinct agent files in `_synapse/agents/`:
  - `general.agent.md`: General-purpose assistant for general chat, editing, and search.
  - `vision.agent.md`: Vision-capable assistant for image and diagram analysis.
  - `zettelkasten.agent.md`: Methodology assistant for atomic notes and dense linking.
  - `para.agent.md`: Methodology assistant for Projects, Areas, Resources, and Archives.
  - `lyt.agent.md`: Methodology assistant for Linking Your Thinking and Maps of Content (MOCs).
- **Per-Agent Model Bindings**: Each vault agent's bound model (`model:` frontmatter property) is editable directly within the Settings tab. Changes immediately modify the underlying `.agent.md` file in the vault.

## Local models (issue #220 — provider matrix removed)

The old `ProviderPreset` (`'ollama' | 'openai' | 'azure'`) BYOK matrix and its
`executeLocalProviderQuery()` ReAct loop, along with their per-preset Settings UI (Provider
dropdown, Base URL, API key, Bearer token, capability-detection heuristics, Azure-specific URL
guidance, the debounced `initAgentService()` field), were removed by issue #220 — see
`.docs/decisions/2026-09-09-anthropic-only-provider-and-batch-loop-removal.md`. Only Claude and
the **local agent endpoint** (below, issue #122) remain as model sources; there is no provider
preset to select anymore.

### Local agent endpoint (issue #122)

The Claude tab's **Local agent endpoint** section replaces the old BYOK fields with two settings —
**Endpoint URL** (`localAgentEndpointUrl`) and **Endpoint API key** (`localAgentEndpointApiKey`,
stored securely like the other secrets) — plus a **Test** button. Setting a URL points local-model
queries at that endpoint via `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` (see
`agent-service.md`'s `buildEnv()`), so local models run through the same Agent SDK/CLI as Claude:
full streaming, tool use, skills, and permission modes, instead of the old degraded one-shot loop.

Model discovery is `fetchEndpointModels({baseUrl, apiKey})` (`src/providerModels.ts`) — ONE
Obsidian `requestUrl()` GET to `<baseUrl>/v1/models`, with the same base-URL normalization and
blank-key→`'ollama'` rule as the Test probe below, mapping the OpenAI-shaped
`{data: [{id, ...}]}` catalogue to `ModelInfo[]`. `main.ts#initAgentService()` calls it whenever
`localAgentEndpointUrl` is set, and a successful result flows through `plugin.setProviderModels()`
→ `AgentService#setCustomModels()` → `plugin.notifySidebarModelsChanged()` →
`SynapseView#refreshProviderModels()`, populating the toolbar's model `<select>` alongside the
Claude models. There is no per-model capability catalogue anymore — an unknown model id defaults
tool-capable per issue #129's unknown≠unsupported rule (the SDK path never gated on it).

### Local agent endpoint Test button (issue #223)

The **Endpoint URL** setting has its own **Test** button, verifying the endpoint actually speaks
the Anthropic Messages API — the thing that otherwise only surfaces when a query fails
mid-conversation. A **blank endpoint URL** shows the guiding Notice "Endpoint URL is empty — enter
one above (default for Ollama: localhost:11434)." before the disable/`'Testing…'` dance, performing
no network request at all.

The probe itself is `testLocalAgentEndpoint({baseUrl, apiKey})` (`src/providerModels.ts`, next to
`fetchEndpointModels()`) — ONE Obsidian `requestUrl` POST to `<baseUrl>/v1/messages` with the same
Anthropic-protocol headers the CLI's Messages API client sends (`x-api-key`,
`anthropic-version: 2023-06-01`) and a minimal 1-turn user message with `max_tokens: 16`. It does
not spawn the CLI and does not call `fetchModels()` (the SDK warm-start would validate Claude-auth
env, not the endpoint); it is read-only aside from the single probe request — no `saveSettings()`,
no `initAgentService()`. Locked by `test/localAgentEndpoint.test.ts`.

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
  `window.setTimeout` (the codebase's `Promise.race` pattern) — a dead-but-accepting host can't
  hang the button. Empirically (live Ollama v0.33.3), 200 OK arrives in well under a second; the
  request completes with `stop_reason: 'max_tokens'` long before full generation.

### Legacy `providerBaseUrl` migration notice (issue #220, planner decision 6)

No migration shim for the removed `providerPreset`/`providerBaseUrl`/`providerApiKey`/
`providerBearerToken` keys — `main.ts#loadSettings()` strips them from the merged settings on
load (so `saveSettings()` doesn't re-persist them forever), and fires a one-time `Notice` (same
convention as #117's `anthropic`-preset migration notice) when the loaded `data.json` carried a
non-empty `providerBaseUrl`, pointing the user at **Settings → Synapse → Claude → Local agent
endpoint**. The two removed secrets (`providerApiKey`/`providerBearerToken`) are dropped from
`SECURE_FIELDS`; stale localStorage values for them are harmless (nothing reads that prefix
anymore).

## Invariants

- Secrets (tokens, password inputs) never land in `data.json`.
- `reasoningEffort: ''` means "model default" — never send the empty string to the SDK; the
  field is omitted from the session config instead.
- (issue #106) `reasoningSummary` and `contextTier` were removed from `SynapseSettings` — they
  were pre-Agent-SDK controls that were never actually passed to `query()` (persisted a
  setting and updated a toolbar badge with no effect on the session). They are intentionally
  **not** re-added to the type, but old `data.json` files carrying those keys still load without
  error: `main.ts#loadSettings` merges persisted data over `DEFAULT_SETTINGS` via
  `Object.assign({}, DEFAULT_SETTINGS, raw)`, so the stale keys just ride along as harmless
  untyped properties rather than causing a load failure or wiping unrelated settings.
- (issue #148) `synapseFolder` was removed from `SynapseSettings` and `DEFAULT_SETTINGS` —
  it was declared and defaulted (to `SYNAPSE_FOLDER`) but **nothing in `src/` ever read it**;
  every call site uses the `SYNAPSE_FOLDER` constant (`src/vaultPaths.ts`) directly. This is a
  genuine no-op migration — dropping the setting changes no behaviour, because the value was
  never consulted in the first place, not even to seed a default that then diverged. (Contrast
  `configWriter.ts#ensureImproveSynapseSkill`'s `synapseFolder` *parameter*, which defaults to
  `SYNAPSE_FOLDER` and *is* used within that function — an unrelated same-named identifier, out
  of scope for #148 and unchanged.) Same load-time tolerance as the #106 keys above: old
  `data.json` files carrying a stale `synapseFolder` still load without error via the same
  `Object.assign` merge, riding along as a harmless untyped property. Locked by
  `test/settings.test.ts`'s `legacy settings key tolerance` block, extended for #148 to include
  `synapseFolder` alongside `contextTier`/`reasoningSummary`.
- (issue #188) `triggerLastFired: Record<string, number>` was removed from `SynapseSettings` and
  `DEFAULT_SETTINGS` along with the rest of the trigger system (`src/triggers.ts`,
  `src/triggerExecutor.ts`, the **Triggers** settings tab). It is intentionally **not** re-added
  to the type. Same no-op-migration treatment as `synapseFolder` above: an existing `data.json`
  with a stale `triggerLastFired` object still loads without error via `main.ts#loadSettings`'s
  `Object.assign({}, DEFAULT_SETTINGS, raw)` merge — the stale object just rides along as a
  harmless untyped property, never read by anything, and is dropped the next time settings are
  saved (`saveSettings()` only ever writes the current `SynapseSettings` shape, so the key
  disappears from `data.json` on the vault's next save rather than needing an explicit strip
  step). No `_synapse/triggers/*.md` files are touched by this removal — see
  [config-writer.md](config-writer.md) for that vault-content invariant.
- `inlineModel` was removed from `SynapseSettings` and `DEFAULT_SETTINGS` (and its UI Setting box
  "Model name" removed from the Claude settings tab) — it was never consulted by any agent loop,
  inline operation, or chat session (the chat toolbar model picker and endpoint catalogue handle
  model selection). Old `data.json` files carrying `inlineModel` still load without error via the
  same `Object.assign` merge as the other legacy keys. Locked by `test/settings.test.ts`'s
  `legacy settings key tolerance` suite.
- Settings changes that affect an active session mark the session config dirty; a new or
  reconfigured session picks them up.
- All local agent endpoint HTTP calls (the Test button, `main.ts#initAgentService()`'s discovery
  request) go through `fetchEndpointModels()`/`testLocalAgentEndpoint()` (`src/providerModels.ts`)
  — don't duplicate the `/v1/models`/`/v1/messages` fetch-and-parse logic inline in `settings.ts`
  or `main.ts`.
