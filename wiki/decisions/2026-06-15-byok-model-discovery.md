# BYOK provider model discovery in Settings -> Models

## Context

Settings -> Sidekick -> Models lets users point Sidekick at a "Bring Your Own Key" (BYOK)
provider instead of the built-in GitHub Copilot backend — presets for OpenAI, Azure/Foundry,
Anthropic, Ollama, Microsoft Foundry Local, and a generic "other OpenAI-compatible" option.
Each preset exposes **Base URL**, **Model name**, **API key**, **Bearer token**, and a **Wire
API** dropdown, plus a **Test** button.

Today, **Test** only proves the provider connection works: it calls
`copilot.createSession({...providerConfig})` and immediately disconnects. It does not tell the
user which models are actually available, and **Model name** is a free-text field the user
must fill in by hand — they have to already know the exact model ID the provider expects
(e.g. `Phi-4-cuda-gpu:1`, not the friendly alias `phi-4`), as documented in
[`wiki/foundry-local-setup.md`](../foundry-local-setup.md).

Separately, `src/main.ts` already contains a `buildOnListModels()` helper that, for BYOK
presets with a base URL, fetches the model list from `GET /v1/models` (OpenAI-compatible:
openai/azure/anthropic/foundry-local/other-openai) or `GET /api/tags` (Ollama), using
`apiKey`/`bearerToken` as `Authorization: Bearer ...`. This is wired into `CopilotClient`'s
`onListModels` option — but nothing currently calls `copilot.listModels()` for BYOK presets,
so the plumbing is dormant. The sidebar chat view's model picker
(`populateModelSelect()` in `src/view/configToolbar.ts`) already lists and lets the user pick
models for the GitHub preset via `copilot.listModels()`, but for BYOK it currently just shows
a single synthesized entry echoing the free-text **Model name** setting.

This decision was reached in a `grill-me` elicitation on **2026-06-15**, prompted by the user's
day-to-day friction running Sidekick against a local Microsoft Foundry Local instance.

## Decision

Split the work into two phases. **This record scopes Phase 1 in full**; Phase 2 is recorded
only as a direction so the technical planner understands where Phase 1's output is headed,
not so it gets built now.

### Phase 1 — Settings -> Models: Test becomes model discovery

For **all BYOK presets** (openai, azure, anthropic, ollama, foundry-local, other-openai — i.e.
everything except the `github` preset), the Models-tab **Test** button changes from a
connectivity-only `createSession` + disconnect check to a **direct model-list fetch**:
`GET /v1/models` for openai/azure/anthropic/foundry-local/other-openai, `GET /api/tags` for
ollama. This reuses (by extraction, see implementation notes) the fetch logic that already
exists in `buildOnListModels()`.

Three outcomes:

- **Success, N > 0 models** — Notice: "Connected — found N model(s)." The fetched model
  IDs/names populate a `<datalist>` attached to the **Model name** field (see below).
- **Success, 0 models** — Notice: "Connected, but the provider reported no available models."
  This is the expected, normal state for Foundry Local when the service is running but no
  model has been loaded yet. The datalist is cleared — no stale entries linger from a
  previous successful Test.
- **Network / auth / parse error** — Notice: "Test failed: \<error\>" (same wording style as
  today's error notice).

The **Copilot tab's** "Client type" Test button (the `github` preset, `createSession`-based
connectivity check) is **unchanged**. This decision only touches the Models-tab BYOK Test
button.

### Phase 1 — Model name field becomes datalist-backed

**Model name** stays a plain text `<input>`, not a strict `<select>`. It gains an HTML
`<datalist>` populated from the model IDs/names returned by the last successful Test. Users
can pick a suggestion from the datalist or type any value freely.

This is deliberate, not a placeholder: the field must keep working

- before the user has ever clicked Test, and
- for any BYOK endpoint whose model-list endpoint doesn't match the generic `/v1/models` or
  `/api/tags` shape (datalist is simply empty/absent — no validation error, no blocking).

### Phase 1 — Preset scope

Applies uniformly to **all** BYOK presets via the same generic fetch logic — no
preset-specific exclusions or special cases in Phase 1. Microsoft Foundry Local is the
preset the user will actually validate day-to-day. For presets where the real provider's
model-listing API differs from the generic assumption (most notably Azure OpenAI's
deployment-listing API, see implementation notes below), Test may legitimately report
"failed" or "0 models" — that is an honest signal and **not a regression** versus today's
behavior (today's Test doesn't tell the user about models at all).

### Phase 2 — direction only (not scoped here)

Settings' **Model name** becomes a **permanent default/fallback model** for BYOK sessions —
not a stopgap Phase 2 removes. Phase 2 will additively wire the sidebar model picker
(`populateModelSelect()`) to the same model-list source for BYOK presets via
`copilot.listModels()`, closing the dormant-`onListModels`-plumbing gap noted above. Users
will then be able to override the model per-session from the sidebar for BYOK presets exactly
as they already can for `github` — while Settings' **Model name** remains the default when no
per-session override has been made.

Nothing from Phase 1 is expected to be reworked or removed by Phase 2. Phase 2 needs its own
grilling/planning round when it's picked up.

## Rationale

- **Foundry Local's real pain point is "I don't know the exact model ID."** `foundry model
  list` shows friendly aliases (`phi-4`) but the API needs the full model ID
  (`Phi-4-cuda-gpu:1`). A datalist sourced from the live `/v1/models` response removes that
  guesswork entirely for the priority use case.
- **A direct fetch is simpler and more honest than reusing `createSession`.** The existing
  Test already creates and tears down a session just to prove connectivity; fetching
  `/v1/models` directly is a strict superset of that check (if the fetch succeeds, the
  endpoint is reachable) while also answering "what models do I have."
- **Keeping Model name as free text + datalist (not a hard `<select>`)** avoids ever blocking
  the user on a provider whose model-listing endpoint doesn't match the generic shape —
  consistent with this fork's general "BYOK is best-effort, never required" posture.
- **Uniform preset scope** avoids special-case logic for a feature whose primary value (for
  this user, today) is the Foundry Local case; presets with non-conforming endpoints degrade
  gracefully rather than being excluded outright.
- **Phasing** separates "make the Models tab tell the truth about available models" (Phase 1,
  self-contained, immediately useful) from "let the sidebar pick BYOK models the way it
  already does for GitHub" (Phase 2, larger, touches session/cache lifecycle) — each phase is
  independently shippable and reviewable.

## Scope / Non-goals

- **Not in Phase 1:** any change to the sidebar model picker (`configToolbar.ts`,
  `populateModelSelect()`) or to `copilot.listModels()` / `onListModels` wiring — that is
  Phase 2.
- **Not in Phase 1:** the Copilot tab's "Client type" Test button / `github`-preset
  connectivity check — unchanged.
- **Not in Phase 1:** fixing provider-specific auth-header conventions (Azure `api-key`,
  Anthropic `x-api-key` vs. generic `Authorization: Bearer`) beyond what's noted for the
  planner below — Phase 1 ships with the existing generic auth assumption and accepts that
  some presets' Test results may not perfectly predict real session auth behavior.
- **Not in Phase 1:** fixing the suspected Azure base-URL / `/v1/models` path-doubling issue
  (flagged separately below) — out of scope unless the user asks for it as its own item.
- **No new settings fields** beyond what's needed to back the datalist (the datalist itself is
  UI-only state derived from the last Test response; whether/how it's persisted across
  Obsidian restarts is an implementation detail for the planner).

## Open Questions

- Should the fetched model list (for the datalist) be persisted in `data.json` /
  `localStorage`, or only held in memory for the current Settings-tab session? Not decided —
  left to the technical planner/coder; either choice is consistent with this record as long as
  "before first Test, datalist is empty and the field still works" holds.
- Exact Notice wording is fixed above ("Connected — found N model(s).", "Connected, but the
  provider reported no available models.", "Test failed: \<error\>") — no open question there,
  but the planner should preserve these strings verbatim for consistency with
  `wiki/foundry-local-setup.md`'s existing walkthrough (which will need a follow-up edit once
  Phase 1 ships — see cross-links below).

## Hand-off Notes for the Technical Planner

The functional decisions above are final (pending the usual planner audit against `specs/`).
The following are **implementation notes carried over from the elicitation** — flag them,
don't treat them as decided product scope unless the user is asked separately:

1. **Extract a shared "fetch provider models" helper.** `buildOnListModels()` in
   `src/main.ts` already contains the fetch-and-parse logic for both the OpenAI-compatible
   `/v1/models` shape and Ollama's `/api/tags` shape. Recommend extracting this into a
   reusable function so both (a) the Settings Test button (Phase 1, called directly, no SDK
   involvement) and (b) the SDK's `onListModels` callback (Phase 2, via
   `copilot.listModels()`) share one implementation rather than diverging.

2. **`onListModels` / `listModels()` caching is a Phase 2 concern, not Phase 1.**
   `onListModels` is captured in a closure at `initCopilot()` time, and the SDK's
   `client.listModels()` caches results after the first call. Phase 1's direct-fetch Test
   button sidesteps all of this (no `CopilotService`/SDK session involved). Phase 2 will need
   to handle cache invalidation / client re-init when BYOK settings change — out of scope now,
   but don't let Phase 1's implementation choices make that harder later.

3. **Auth header precedence/shape may not match real session behavior.**
   `buildOnListModels()` currently does: if `apiKey` is set, send
   `Authorization: Bearer <apiKey>`, else fall back to `bearerToken`. But the SDK's actual
   `ProviderConfig` gives **`bearerToken` precedence over `apiKey`** when both are set, and
   Azure/Anthropic conventionally expect different headers entirely (`api-key` /
   `x-api-key`) rather than `Authorization: Bearer`. Worth reconciling during Phase 1 so a
   successful Test reliably predicts a working session — at minimum for the
   non-Foundry-Local presets (Foundry Local itself typically needs no auth, so this doesn't
   block the priority case, but a wrong precedence could make Test pass while a real session
   fails, or vice versa, for OpenAI/Azure/Anthropic users).

4. **Possible pre-existing bug, separate from this decision:** the Azure provider's default
   base URL (`https://your-resource.openai.azure.com/openai/v1/`) combined with
   `buildOnListModels()`'s generic `${baseUrl}/v1/models` suffix would produce a doubled
   `/v1/v1/models` path. This predates and is independent of this enhancement — flag it to the
   user as a candidate for its own issue rather than folding a fix into Phase 1 silently.

## Related wiki docs

- [`wiki/foundry-local-setup.md`](../foundry-local-setup.md) — documents today's manual flow
  (set Base URL / Model name by hand, Test = connectivity-only, then pick the model in the
  sidebar dropdown, which currently just echoes the configured **Model name**). Once Phase 1
  ships, Step 3's "Click Test to verify" and the Model name guidance should be updated to
  describe the new "Test lists models, pick from the datalist" flow — light-touch edit,
  deferred to Phase 1 implementation rather than done here.
- [`wiki/ai-customization-guide.md`](../ai-customization-guide.md) section 7.7 ("Foundry Local
  and offline knowledge work") — describes Foundry Local as a use case for private/offline
  work; unaffected by this decision but worth a glance if Phase 1's UI copy changes affect the
  setup narrative referenced there.
