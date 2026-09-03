# settings

Source: `src/settings.ts` — settings interface, defaults, and the settings tab UI.

## Groups

- **Claude** — authentication mode (Claude subscription OAuth or Anthropic API key), API key input (stored securely), CLI location override, resolved binary and version status display, and **Test** button.
- **Feature Map & Agents** (replaces legacy Models tab) — feature-to-agent map (`featureAgents`: `chat`, `inline`, `search`, `telegram`, `vision`), shipping methodology-tuned default agents (`General`, `Vision`, `Zettelkasten`, `PARA`, `LYT`), and per-agent model bindings. Model bindings for vault agents (`.agent.md`) can be edited directly in Settings, modifying the file frontmatter with zero local availability hard dependency.
- **Capabilities** — Hardcoded `_synapse/` folder (exported as `SYNAPSE_FOLDER` constant) and **Initialize** button (creates `_synapse/agents/`, `_synapse/skills/`, and `_synapse/triggers/` with sample agents and skills). Also includes editor integration toggles (auto-update working directory, auto-include note images, and max note images), and, under "Chat run guardrails" (issue #88), opt-in interactive-loop thresholds: **Turn limit** (`loopTurnThreshold`), **Token budget** (`loopTokenThreshold`), and **Dollar budget (USD)** (`loopCostThresholdUsd`) — all default to `0` (off). See `.docs/specs/chat-view.md` "Loop turn/cost thresholds" for enforcement details. The `synapseFolder` field remains in `SynapseSettings` for data compatibility but its value is ignored — all code uses the constant.
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

`ProviderPreset` (`src/providerModels.ts`) has exactly three values — `'ollama' | 'openai' |
'azure'` (issue #117) — mapping to two real code paths and one header variant. The dropdown
label for `openai` is **"OpenAI-compatible"**; its description names the providers it covers:
"Works with OpenAI, OpenRouter, LM Studio, llama.cpp, vLLM, Groq, Together, DeepSeek, Mistral,
Foundry Local, and anything else exposing `/v1/chat/completions`." — a documentation-only
statement, not a code path per provider.

For every BYOK preset (`openai`, `azure`, `ollama`), the Models-tab **Test** button performs a
**direct model-list fetch** against the configured provider, via
`fetchProviderModels()` (`src/providerModels.ts`):

- `GET ${baseUrl}/api/tags` for `ollama` (strips a trailing `/v1` from the base URL first,
  since ollama's native endpoint is `/api/tags` on the bare host; parses
  `{ models: [{ name, ... }] }`).
- `GET ${baseUrl}/v1/models` for all other BYOK presets (parses `{ data: [{ id, name?, ... }] }`).
  If the base URL already ends in `/v1` (e.g. Azure's default
  `https://...openai.azure.com/openai/v1/`), appends only `/models` to avoid a doubled
  `/v1/v1/models` path.

All HTTP calls in `src/providerModels.ts` (`fetchProviderModels()` and
`executeLocalProviderQuery()`) use Obsidian's `requestUrl()`, not the browser `fetch()` —
none of them stream a response body (all read a single parsed JSON payload), and
`requestUrl()` runs outside the renderer's CORS sandbox, which matters for local providers
(e.g. Ollama) that don't send CORS headers. `requestUrl()` is called with `throw: false`
so a non-2xx status is inspected via `res.status` rather than thrown; error messages report
`HTTP ${status}` only (no `statusText`, which `requestUrl()` doesn't expose).

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

### Legacy preset migration (issue #117)

`other-openai`, `foundry-local` and `anthropic` were removed from `ProviderPreset` — the first
two were byte-identical to `openai` in both `fetchProviderModels()` and
`executeLocalProviderQuery()` (same URLs, same headers, same body shape), and `anthropic` was
redundant with (and actively harmful alongside) the first-class Claude auth in the **Claude**
group — selecting it routed Claude models through the degraded local ReAct loop instead of the
Agent SDK, and could corrupt `AgentService.isLocalModel()`'s routing for every Claude model in
the plugin. `src/providerModels.ts#migrateProviderPreset()` resolves a possibly-legacy stored
value to one of the three current presets:

- `other-openai` → `openai`, silent.
- `foundry-local` → `openai`, silent.
- `anthropic` → `openai`, **plus a one-time `Notice`** (shown from `main.ts#loadSettings()`)
  explaining that Anthropic/Claude models belong in **Settings → Claude → API key**, since this
  migration silently changes which key drives chat.
- Any other **non-empty** unrecognized value → `openai` (defensive fallback, same as the
  pre-existing `options.preset || 'openai'` default used throughout `providerModels.ts`).
- An **absent/empty/whitespace-only** value → `migrated: false`, i.e. not a legacy alias at
  all. This is the fresh-install / pre-this-setting case, where `Object.assign({}, DEFAULT_
  SETTINGS, raw)` has already seeded `providerPreset: 'ollama'` — the migration must not
  overwrite that with the unrecognized-value fallback (issue #117 review round 1 caught a
  version that did, defaulting every fresh install to `openai` instead of `ollama`).

`loadSettings()` calls this on every load; when it reports `migrated: true` it overwrites
`settings.providerPreset` and forces a `saveSettings()` write, so the notice fires exactly once
per vault — after the first post-upgrade load, the persisted value is already `openai` and the
legacy branch no longer matches. The `providerPreset` settings key itself is unchanged; only its
set of valid values narrowed.

`fetchProviderModels()` is also the basis for `buildOnListModels()`'s `onListModels` callback
(used by `AgentService` for the inline-operations model dropdown today; the sidebar BYOK
model picker wiring is Phase 2, not yet built — `populateModelSelect()` in
`src/view/configToolbar.ts` still echoes the free-text **Model name** for BYOK).

**Auth headers** (`fetchProviderModels()`, shared by Test and `onListModels`): mirrors the
SDK's `ProviderConfig` precedence — `bearerToken` wins over `apiKey` when both are set — and
uses provider-appropriate header shapes: `api-key` for `azure`, `Authorization: Bearer <token>`
for `openai` and `ollama`. This makes a successful Test a reliable (though not 100%
guaranteed — deployment-listing APIs like Azure's can differ) predictor of session auth working.
Locked by `test/providerModels.test.ts`, table-driven over `{preset, baseUrl}` for all three
presets across both a bare and a trailing-`/v1` base URL, asserting the model-list URL, chat
URL, auth header and request body shape.

### Ollama bearer token (issue #120)

The **API key** field is hidden for the `ollama` preset (local daemon needs none, and neither
does Ollama Cloud — the local daemon brokers that auth; see
`.docs/decisions/2026-06-26-ollama-cloud-models-support.md`). A separate, optional **Bearer
token** field is shown only when `providerPreset === 'ollama'`, for the case those two don't
cover: a remote Ollama sitting behind a reverse proxy or a token-gated tunnel (a common
home-server setup). Its description says explicitly it's needed only for that case, not for
local or Ollama Cloud use.

- Backed by the existing `providerBearerToken` setting — no new settings key. It was already
  declared on `SynapseSettings`, defaulted to `''`, and listed in `SECURE_FIELDS`; `fetch
  ProviderModels()`/`executeLocalProviderQuery()` already read it (`bearerToken` wins over
  `apiKey` when both are set, per the SDK's `ProviderConfig` precedence). Only the UI control
  was missing before this change.
- Persisted exactly like `providerApiKey`/`anthropicApiKey`/`telegramBotToken`: `updateSecure
  Field()` writes it to `plugin.settings` in memory and to vault-scoped local storage via
  `saveSecureField()` (`synapse-secure-providerBearerToken` key), **not** `data.json`. `main.ts#
  loadSettings()`'s `SECURE_FIELDS` loop already round-trips it on load, same as the other three
  secrets — no changes needed there.
- Rendered as a `type="password"` input with `autocomplete="off"`, matching the API key field.
- Blank (the default) is behaviourally identical to before this change: no `Authorization`
  header is sent for `ollama` unless a token is present.

### Azure base-URL UI (issue #119)

Azure OpenAI works **only** against its v1 API surface
(`https://<resource>.openai.azure.com/openai`), not the classic deployment-scoped surface
(`https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-
version=...`) — Synapse's URL builder always requests `{base}/v1/models` and
`{base}/v1/chat/completions` and can never produce the classic shape. Three UI touches make this
discoverable instead of a silent 404:

- **Base URL placeholder** (`settings.ts`, the same conditional that already special-cases
  `ollama`): shows `https://<resource>.openai.azure.com/openai` when `providerPreset === 'azure'`
  (falls through to the `openai`/generic placeholder `https://api.openai.com` otherwise).
- **Provider description** (`updateProviderDesc()`, same function that already branches on
  `ollama`/`openai`): for `azure`, names the v1 API endpoint as the required base URL and calls
  out both wrong shapes it is not — the bare resource endpoint and a classic deployment-scoped
  URL — mirroring the two cases `describeAzureBaseUrlIssue()` below detects, so the three UI
  strings (placeholder, description, Test failure) tell one consistent story.
- **Friendlier Test failure** — `describeAzureBaseUrlIssue(baseUrl)` (`src/providerModels.ts`)
  detects two distinct predictable wrong inputs and returns a distinguishable message naming the
  fix for each, instead of the generic `Test failed: HTTP 404`:
  - **Classic deployment-scoped URL** — a `/deployments/` path segment or an `api-version=` query
    parameter (case-insensitive).
  - **Bare portal Endpoint** (review round 1) — the value the Azure portal actually shows/copies,
    `https://<resource>.openai.azure.com/` with no path, and therefore the *more* likely wrong
    paste, not the deployment URL. Detected by host-matching `*.openai.azure.com` first (so a
    preset pointed at some other proxy/gateway host is never second-guessed about a shape this
    module can't verify), then checking whether the path is already `/openai` **or** `/openai/v1`
    (each with an optional trailing slash) — review round 2 caught that `.../openai/v1` is a
    genuinely working base URL (the URL builder's own `endsWith('/v1')` special-case at `:251`
    and `:472` resolves both shapes to the identical `.../openai/v1/...` request), so only a
    path that's empty/`/` (or already matched the deployment fingerprint above) is flagged.
  Returns `null` for an empty/unmatched URL (the empty case is already reported by
  `fetchProviderModels()`'s "Base URL is required." error) and for a non-Azure host. The Test
  button's failure branch in `settings.ts` calls this only when `providerPreset === 'azure'`, and
  prefers it over the generic `Test failed: ${error}` notice when it returns a message. Locked by
  `test/providerModels.test.ts`'s `describeAzureBaseUrlIssue` block.

Hands-on confirmation that `GET https://<res>.openai.azure.com/openai/v1/models` returns the
OpenAI-shaped `{data: [...]}` `fetchProviderModels()` parses is **not yet recorded** — no Azure
resource was available during implementation; see issue #119.

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
  - Regardless of the heuristic result, the plugin also fires a `POST /api/show` request per
    model with `{"model": "<name>"}` and inspects the `capabilities` array returned from the
    response — it takes priority over the heuristic when it succeeds. If `"vision"` is in the
    list, vision is supported. If `"tools"` is in the list, tool execution is supported.
  - **Bound-concurrent, not serial (issue #120)**: `fetchProviderModels()` dispatches these
    `/api/show` calls through an internal `mapWithConcurrency()` helper with a cap of 5 in
    flight at once, rather than `await`ing them one at a time inside the model loop or firing
    an unbounded `Promise.all`. A 20-model library previously meant 20 sequential round-trips
    (a Test button that felt broken); the cap keeps a large local library from flooding the
    daemon while still parallelising the common case. A single model's `/api/show` failing
    (network error or non-2xx) only affects that model — it falls back to the heuristic result
    and does not fail discovery for the rest, same as before this change.
  - **Cache keyed on `baseUrl + '\0' + id`, not `id` alone (issue #120)**: `ollamaShowCache`
    used to key on the model id only, so switching the Ollama `baseUrl` between two hosts
    (e.g. laptop → home server) served stale capabilities cached from whichever host was
    queried first for a same-named model. `ollamaShowCacheKey(baseUrl, id)` composes the key
    from both so each host gets its own cache entries; `clearOllamaShowCache()` (called by the
    Test button before every run) still clears the whole map regardless of key shape. Locked by
    `test/providerModels.test.ts`'s `ollama /api/show discovery (#120)` block.

- **Non-Ollama BYOK Providers (openai, azure)** (issue #129): **metadata-first**, per field
  independently, with a name-based heuristic as an explicit last resort — `deriveCatalogueCapabilities()`
  in `src/providerModels.ts`. Field names were verified against a live
  `GET https://openrouter.ai/api/v1/models` response (2026-09-03); they are read **generically**
  off any catalogue entry that publishes them, not gated on `preset` or hostname, so any
  OpenAI-compatible backend that returns the same field names benefits, not just OpenRouter:
  - **`supported_parameters: string[]`** on the model object — `'tools'` present means the model
    accepts an OpenAI-style `tools` array; `'tools'` **absent from a present array** is treated as
    an authoritative "no" (see **Tools**, below). `'reasoning'` or `'reasoning_effort'` present
    means it accepts a reasoning-effort request parameter. Governs both **Tool support** and
    **Reasoning Effort support**.
  - **`architecture.input_modalities: string[]`** — `'image'` present means vision input.
    Governs **Vision support**.
  - **`reasoning.supported_efforts: string[]`**, when present, is used verbatim as the model's
    `supportedReasoningEfforts` instead of the generic three-level fallback list.
  - A catalogue entry may publish some of these fields and omit others (a "partial" catalogue —
    e.g. modality info but no `supported_parameters`); each capability falls back to its own
    heuristic only when its own field is absent, never when the model object as a whole lacks any
    metadata.
  - **Fallback heuristics** (only used when the corresponding field above is absent):
    - **Vision**: the pre-#129 fixed-allowlist regex on the model ID (`gpt-4o`, `gpt-4-vision`,
      `claude-3`, `gemini-1.5`, `vision`, `pixtral`), unchanged, now scoped as a last resort
      rather than the default path.
    - **Tools**: `supported_parameters` present and lacking `'tools'` → `false` — this is the real
      new, deliberate behaviour #129 asked for: the catalogue authoritatively said no.
      `supported_parameters` **absent entirely** → `true` (optimistic, unchanged from before this
      change), not `false`. A bare OpenAI-shaped `{id, object, created, owned_by}` catalogue —
      what OpenAI's own `/v1/models` and Azure's `/openai/v1/models` both return, i.e. the common
      case for the two flagship presets, not an edge case — carries no information either way.
      `triggerExecutor.ts`'s `const supportsTools = modelInfo?.supportsTools !== false;` treats
      anything but a hard `false` as "equip this model with vault tools and start the MCP bridge";
      defaulting an *absent* field to `false` would silently drop every trigger's vault tools with
      no error on exactly the backends most users are on. Ollama's own `false` default (above) is
      not a counter-example: it is backed by a per-model `/api/show` call — a *confirmed* answer —
      not an *absent* one, so the two states are not the same and must not produce the same flag.
    - **Reasoning**: tightened from the pre-#129 `/o1|o3/i` substring test (matched the letters
      "o1"/"o3" anywhere in an id) to `/(?:^|\/)o[13](?:-|$)/i` — the token must start the id or
      immediately follow a `/`, and must itself be immediately followed by `-` or end-of-string,
      so it recognizes OpenAI's real `o1`/`o1-mini`/`o1-preview`/`o3`/`o3-mini`/`openai/o3-...`
      naming without matching an unrelated id that merely contains that two-character run.
  - Locked by `test/providerModels.test.ts`'s `catalogue capability metadata (#129)` block: full
    metadata, a model with `supported_parameters` present but lacking `tools`/`reasoning` (the
    authoritative-unsupported case), a bare OpenAI-shaped catalogue with no capability fields at
    all (asserting `supportsTools: true`, not `false`), the tightened reasoning regex's
    non-over-matching, and a partial catalogue exercising per-field-independent fallback.

## Invariants

- Secrets (tokens, password inputs) never land in `data.json`.
- `reasoningEffort: ''` means "model default" — never send the empty string to the SDK; the
  field is omitted from the session config instead.
- (issue #106) `reasoningSummary` and `contextTier` were removed from `SynapseSettings` — they
  were Copilot-SDK-era controls that were never actually passed to `query()` (persisted a
  setting and updated a toolbar badge with no effect on the session). They are intentionally
  **not** re-added to the type, but old `data.json` files carrying those keys still load without
  error: `main.ts#loadSettings` merges persisted data over `DEFAULT_SETTINGS` via
  `Object.assign({}, DEFAULT_SETTINGS, raw)`, so the stale keys just ride along as harmless
  untyped properties rather than causing a load failure or wiping unrelated settings.
- Settings changes that affect an active session mark the session config dirty; a new or
  reconfigured session picks them up.
- All BYOK provider HTTP calls (Test, `onListModels`) go through `fetchProviderModels()`
  (`src/providerModels.ts`) — don't duplicate the `/v1/models` / `/api/tags` fetch-and-parse
  logic inline in `settings.ts` or `main.ts`.
