# settings

Source: `src/settings.ts` — settings interface, defaults, and the settings tab UI.

## Groups

- **Claude** — authentication mode (Claude subscription OAuth or Anthropic API key), API key input (stored securely), CLI location override, resolved binary and version status display, and **Test** button.
- **Feature Map & Agents** (replaces legacy Models tab) — feature-to-agent map (`featureAgents`: `chat`, `inline`, `search`, `telegram`, `vision`), shipping methodology-tuned default agents (`General`, `Vision`, `Zettelkasten`, `PARA`, `LYT`), and per-agent model bindings. Model bindings for vault agents (`.agent.md`) can be edited directly in Settings, modifying the file frontmatter with zero local availability hard dependency.
- **Capabilities** — Hardcoded `_synapse/` folder (exported as `SYNAPSE_FOLDER` constant) and **Initialize** button (creates `_synapse/agents/`, `_synapse/skills/`, and `_synapse/triggers/` with sample agents and skills). Also includes editor integration toggles (auto-update working directory, auto-include note images, and max note images), and, under "Chat run guardrails" (issue #88), opt-in interactive-loop thresholds: **Turn limit** (`loopTurnThreshold`), **Token budget** (`loopTokenThreshold`), and **Dollar budget (USD)** (`loopCostThresholdUsd`) — all default to `0` (off). See `specs/chat-view.md` "Loop turn/cost thresholds" for enforcement details. The `synapseFolder` field remains in `SynapseSettings` for data compatibility but its value is ignored — all code uses the constant.
- **Tools** — tools approval mode (`ask` or `allow`), and MCP input variable management (with secure storage for password inputs).
- **Bots** — Telegram bot configuration (bot identifier, token stored via secure storage, allowed user IDs, and default agent picker).
- **Triggers** — list of all triggers found in `_synapse/triggers/`, with enable/disable toggle (writes `enabled` frontmatter field via `modifyArtifact`) and last-fired timestamp (from `triggerLastFired` in settings). Includes an **Open triggers folder** button that reveals the folder in the file explorer. Empty state shows a hint to create `.md` files in `_synapse/triggers/`.

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

For every BYOK preset (`openai`, `azure`, `anthropic`, `ollama`, `foundry-local`,
`other-openai` — everything except `github`), the Models-tab **Test** button performs a
**direct model-list fetch** against the configured provider, via
`fetchProviderModels()` (`src/providerModels.ts`):

- `GET ${baseUrl}/api/tags` for `ollama` (strips a trailing `/v1` from the base URL first,
  since ollama's native endpoint is `/api/tags` on the bare host; parses
  `{ models: [{ name, ... }] }`).
- `GET ${baseUrl}/v1/models` for all other BYOK presets (parses `{ data: [{ id, name?, ... }] }`).
  If the base URL already ends in `/v1` (e.g. Azure's default
  `https://...openai.azure.com/openai/v1/`), appends only `/models` to avoid a doubled
  `/v1/v1/models` path.

`fetchProviderModels()` returns a discriminated result (`ok` + `models: ModelInfo[]`, or an
error) rather than swallowing failures into `[]`, so the Test handler can distinguish the
three outcomes:

- **N > 0 models** — `new Notice('Connected — found N model(s).')`. The returned model
  `id`/`name` pairs populate a `<datalist>` wired to the **Model name** `<input>`.
- **0 models, request succeeded** — `new Notice('Connected, but the provider reported no
  available models.')`. This is the expected steady state for Foundry Local when the service
  is up but no model is loaded. The datalist is cleared (no stale entries from a previous
  Test).
- **Network / auth / parse error** — `new Notice('Test failed: ' + error)`, same wording as
  the existing Copilot-tab Test failure. Datalist is cleared. For the `ollama` preset,
  connection errors show a specific message: "Could not connect to Ollama. Make sure Ollama
  is running ("ollama serve") and the base URL is correct."

For the `ollama` preset specifically:
- **0 models** — notice reads "Connected to Ollama, but no models are installed. Pull one
  with 'ollama pull llama3.1'."
- **N > 0 models, no model selected** — notice appends "Select a model in the Model name
  field below."
- The **Provider** setting description dynamically updates to show Ollama setup instructions
  when the `ollama` preset is selected.

The `github` BYOK preset was removed as part of the Claude Agent SDK migration (see
`wiki/decisions/2026-06-28-claude-agent-sdk-migration.md`). Only local/OpenAI-compatible
presets remain; all use the `fetchProviderModels()` path described above.

`fetchProviderModels()` is also the basis for `buildOnListModels()`'s `onListModels` callback
(used by `CopilotService` for the inline-operations model dropdown today; the sidebar BYOK
model picker wiring is Phase 2, not yet built — `populateModelSelect()` in
`src/view/configToolbar.ts` still echoes the free-text **Model name** for BYOK).

**Auth headers** (`fetchProviderModels()`, shared by Test and `onListModels`): mirrors the
SDK's `ProviderConfig` precedence — `bearerToken` wins over `apiKey` when both are set — and
uses provider-appropriate header shapes: `api-key` for `azure`, `x-api-key` for `anthropic`,
`Authorization: Bearer <token>` for everything else (`openai`, `ollama`, `foundry-local`,
`other-openai`). This makes a successful Test a reliable (though not 100% guaranteed —
deployment-listing APIs like Azure's can differ) predictor of session auth working.

## Model name field (datalist-backed)

**Model name** remains a free-text `<input>` (never a hard `<select>`) — it must keep working
before the user has ever clicked Test, and for endpoints whose model-listing shape doesn't
match `/v1/models` or `/api/tags` (datalist stays empty, no validation error). After a
successful Test with N > 0 models, an HTML `<datalist>` attached to the input is populated
with the fetched model `id`s (and `name` as the visible label where they differ) so the user
can pick from a dropdown-like list or type any value. The datalist is **in-memory only**
(Settings-tab session state) — not persisted to `data.json`/`localStorage`; it resets to empty
when Settings is reopened until Test is clicked again.

## BYOK Model Capability Detection

To enable appropriate feature UI/UX gating (such as vision support for image attachments or reasoning configuration), model capabilities are dynamically detected when listing models from the provider endpoint:

- **Ollama Provider**:
  - Uses a **heuristic-first** approach: checks the model's `details.family` and `details.families` arrays returned by `/api/tags`.
  - Multimodal/vision support is detected if the family/families array contains `"mllama"` or `"clip"`, or if the model name includes known vision keywords (e.g. `vision`, `llava`, `minicpm`, `moondream`, `gemma3`).
  - If the heuristic is inconclusive (e.g. unknown family/families), the plugin fires a cached, parallel `POST /api/show` request with `{"model": "<name>"}` and inspects the `capabilities` array returned from the response. If `"vision"` is in the list, vision is supported. If `"tools"` is in the list, tool execution is supported.
  - Results of `/api/show` are cached in memory (at the settings tab or provider model lifecycle level) to avoid redundant network calls.

- **Non-Ollama BYOK Providers (OpenAI, Azure, Anthropic, etc.)**:
  - Since standard `/v1/models` responses contain no capability fields, name-based regex heuristics are used on the model ID.
  - **Vision Support**: Enabled if the model ID matches a case-insensitive regex for known vision-capable models (e.g. `gpt-4o`, `gpt-4-vision`, `claude-3`, `gemini-1.5`, `vision`, `pixtral`).
  - **Reasoning Effort/Summary Support**: Enabled if the model ID matches reasoning models (e.g. `o1`, `o3`).

## Invariants

- Secrets (tokens, password inputs) never land in `data.json`.
- `reasoningEffort: ''` / `reasoningSummary: ''` mean "model default" — never send the empty
  string to the SDK; the field is omitted from the session config instead.
- Settings changes that affect an active session mark the session config dirty; a new or
  reconfigured session picks them up.
- All BYOK provider HTTP calls (Test, `onListModels`) go through `fetchProviderModels()`
  (`src/providerModels.ts`) — don't duplicate the `/v1/models` / `/api/tags` fetch-and-parse
  logic inline in `settings.ts` or `main.ts`.
