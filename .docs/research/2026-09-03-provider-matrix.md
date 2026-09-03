# Provider presets — what works, what to cut, what to add

> Date: 2026-09-03 · Research report, no code changes.
> Question asked: the provider combo box offers six presets besides Ollama. Do they work? Should
> some be removed? Minimal maintenance is wanted beyond Claude + Ollama — but anything that rides
> the same code path is acceptable. Is OpenRouter worth adding?
>
> Verified by reading `src/providerModels.ts`, `src/settings.ts`, `src/agentService.ts` against each
> provider's current API documentation. Requests were **not** executed against live paid endpoints;
> where that matters it is flagged as needing hands-on confirmation.

---

## 0. The short answer

**There are six presets and only two code paths.** Four of the six are pure UI theatre — they
select strings that the code treats identically. One of the remaining two is subtly broken. One is
architecturally harmful.

Recommended dropdown: **Ollama · OpenAI-compatible · Azure OpenAI** — three entries, two code
paths, one header variant. Everything else moves into a documentation table, which costs nothing to
maintain and covers *more* providers than the current dropdown does.

| Preset today | Verdict | Why |
|---|---|---|
| `ollama` | **Keep** — primary local path | Only preset with a real, distinct implementation |
| `openai` | **Keep**, rename to "OpenAI-compatible" | The generic path; covers most of the world |
| `other-openai` | **Remove** — merge into `openai` | Byte-identical behaviour. Two names, one path |
| `foundry-local` | **Remove** — document instead | Byte-identical to `openai`, **and model discovery is broken**: Foundry Local has no `/v1/models` |
| `azure` | **Keep, but fix the UI** | Genuinely different header. Works *only* against Azure's v1 API with a non-obvious base URL, and nothing in the UI says so |
| `anthropic` | **Remove** | Redundant with first-class Claude auth, **and it corrupts model routing** — see §3 |

Plus one addition that is not a preset: a **Messages-API gateway URL**, which is what actually
gives local models full agent capability. See §6.

---

## 1. There are only two code paths

`providerModels.ts` special-cases exactly three strings, in two functions:

```ts
// fetchProviderModels()      — providerModels.ts:52, 163, 165
// executeLocalProviderQuery() — providerModels.ts:271, 273, 302, 347, 361
if (preset === 'ollama')  { /* native /api/tags, /api/show, /api/chat */ }
else {
    if (preset === 'azure')          headers['api-key'] = token;
    else if (preset === 'anthropic') { headers['x-api-key'] = token;
                                       headers['anthropic-version'] = '2023-06-01'; }
    else                             headers['Authorization'] = `Bearer ${token}`;
    /* {base}/v1/models  and  {base}/v1/chat/completions */
}
```

So the true behaviour matrix is:

| Preset | Model list URL | Chat URL | Auth header | Body shape |
|---|---|---|---|---|
| `ollama` | `{base}/api/tags` + `/api/show` per model | `{base}/api/chat` | `Authorization: Bearer` (if a token exists) | Ollama-native (`stream:false`, `images: string[]`) |
| `openai` | `{base}/v1/models` | `{base}/v1/chat/completions` | `Authorization: Bearer` | OpenAI |
| `other-openai` | *identical to `openai`* | *identical* | *identical* | *identical* |
| `foundry-local` | *identical to `openai`* | *identical* | *identical* | *identical* |
| `azure` | `{base}/v1/models` | `{base}/v1/chat/completions` | `api-key` | OpenAI |
| `anthropic` | `{base}/v1/models` | `{base}/v1/chat/completions` | `x-api-key` + `anthropic-version` | OpenAI |

`openai`, `other-openai` and `foundry-local` are the same three strings falling into the same
`else`. The dropdown implies a choice that does not exist, and every one of those labels is a
support ticket waiting to be filed against a distinction the code never makes.

---

## 2. Per-preset findings

### 2.1 `ollama` — works. Keep. Fix three things.

The only preset with a real implementation, and a good one: native `/api/tags` for listing,
`/api/show` for genuine `capabilities: ['vision', 'tools']` rather than name-regex guessing, and
`/api/chat` with the correct Ollama-native multimodal shape (`content: string` + sibling
`images: string[]`, not OpenAI's `image_url` parts — the comment at `providerModels.ts:290-296`
documents exactly why, and it is right).

Three fixes, all detailed in the code-quality report:

1. **N+1 discovery** — `/api/show` is awaited once per model, serially, inside the loop
   (`providerModels.ts:100-140`). Twenty models = twenty-one sequential round-trips. Bound-parallel
   it.
2. **`ollamaShowCache` is keyed by model id only** (`:36`), so switching Ollama hosts serves stale
   capabilities from the previous host. Key it on `baseUrl + '\0' + id`.
3. **No auth field for Ollama.** `settings.ts:581` hides the API key input whenever the preset is
   `ollama`, and `providerBearerToken` has no UI at all. Ollama Cloud genuinely needs no key — the
   local daemon brokers it, per `2026-06-26-ollama-cloud-models-support.md`, and that reasoning
   holds. But it does not cover a remote Ollama behind a reverse proxy or a token, which is a
   common home-server setup and currently unconfigurable. The code already reads a token if one
   exists (`providerModels.ts:47, 57-60`); only the UI is missing.

### 2.2 `openai` + `other-openai` — one path, two names. Merge.

No behavioural difference whatsoever. Keep one entry, label it **"OpenAI-compatible"**, and let the
description carry the value:

> Works with OpenAI, OpenRouter, LM Studio, llama.cpp, vLLM, Groq, Together, DeepSeek, Mistral,
> Foundry Local, and anything else exposing `/v1/chat/completions`.

That single string documents more providers than the current six-entry dropdown, and adds no code.

### 2.3 `foundry-local` — **model discovery is broken.** Remove the preset.

Two independent reasons.

**It is identical to `openai` in code.** No header, URL or body differs.

**Its Test button cannot work.** Foundry Local's REST surface is:

| What | Endpoint |
|---|---|
| Chat | `POST /v1/chat/completions` ✅ OpenAI-compatible |
| **Model list** | `GET /openai/models` (a bare `string[]`) and `GET /foundry/list` |
| Status | `GET /openai/status` |
| Load / unload | `GET /openai/load/{name}`, `/openai/unload/{name}` |

There is **no `GET /v1/models`.** Synapse requests `{base}/v1/models`, gets a 404, and reports
"Test failed: HTTP 404" — even though chat would work fine. On top of that, Foundry Local's port is
**dynamically assigned** (Microsoft's own docs say never to hardcode it; you read it from
`foundry service status`), so the base URL changes between runs and no sensible default exists.

Supporting it properly means a third code path: `/openai/models` returning a bare string array, then
`/foundry/list` for the `supportsToolCalling` flag. That is real ongoing work against a preview API
whose docs carry a "may include breaking changes without notice" warning — precisely the kind of
maintenance burden to decline.

**Recommendation:** remove the preset. Keep `wiki/Local-Models-Foundry.md`, and rewrite it as: use
the OpenAI-compatible preset, get your port from `foundry service status`, enter the model id
manually because the Test button cannot enumerate them. Honest, accurate, zero code.

### 2.4 `azure` — works, but only in a way nothing tells the user

This is the one preset with a genuinely distinct, correct implementation: Azure OpenAI authenticates
with an `api-key` header, and that is exactly what the code sends.

The problem is the base URL. Synapse builds `{base}/v1/chat/completions` and `{base}/v1/models`.
Azure has two API surfaces:

- **Classic (deployment-scoped):**
  `https://<res>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=…`
  — Synapse can never produce this shape. **Will not work.**
- **v1 API (GA since Aug 2025):** `https://<res>.openai.azure.com/openai/v1/chat/completions`
  — Synapse produces this **if and only if** the user enters
  `https://<res>.openai.azure.com/openai` as the base URL.

So `azure` works, on a single non-obvious input, while the placeholder shown next to the field says
`https://api.openai.com` (`settings.ts:573`) and the description says only "Base URL for the
provider endpoint." A user entering the URL from the Azure portal gets a 404 and no clue why.

**Recommendation:** keep it — three lines of header logic and a real user base — but make the UI
carry its weight: a preset-specific placeholder (`https://<resource>.openai.azure.com/openai`) and
a description naming the v1 API requirement. *Then* it is a supported provider rather than a trap.
Worth a hands-on confirmation that `GET /openai/v1/models` returns the OpenAI-shaped `{data:[…]}`
Synapse expects — I could not verify that without an Azure resource.

### 2.5 `anthropic` — remove it

Three reasons, in ascending order of seriousness.

**It is redundant.** Anthropic access is already first-class: `authType: 'apiKey'` +
`anthropicApiKey` drives the Agent SDK with the full agentic loop, skills, subagents, sessions,
permissions and streaming. Choosing "Anthropic (BYOK)" in the *local provider* dropdown routes the
same models through the hand-rolled ReAct loop instead — strictly worse, for the same key.

**Its auth header is probably wrong for the endpoint it calls.** Anthropic's OpenAI-compatibility
layer serves `POST /v1/chat/completions` at `https://api.anthropic.com/v1/`, and its documented
header table lists `authorization` as fully supported. Synapse sends `x-api-key` +
`anthropic-version` instead — correct for the *native* Messages API and for `GET /v1/models`, but
not what the compat layer documents. Model listing therefore succeeds while chat may 401. Needs
hands-on confirmation; either way it is documented-vs-actual drift on a path that shouldn't exist.

**It actively corrupts model routing.** This is the real reason to cut it.

```ts
// agentService.ts:532-539
isLocalModel(modelId?: string): boolean {
    if (!modelId) return false;
    if (this.customModels.some(m => m.id === modelId)) return true;   // ← line 534
    if (this.isLocalBackendAvailable() && !this.sdkModels.some(m => m.id === modelId)) {
        if (!/^claude-/i.test(modelId)) return true;                  // ← line 536, never reached
    }
    return false;
}
```

`customModels` is whatever the last `/v1/models` call returned. Select the Anthropic preset, press
**Test**, and every `claude-*` id lands in `customModels` (`agentService.ts:484`). From then on,
line 534 returns `true` for every Claude model — the `/^claude-/i` guard on line 536 never runs —
and **every Claude model in the plugin silently routes down the degraded local one-shot path**:
no skills, no subagents, no sessions, no permissions, no streaming. Chat, editor actions, triggers,
batch loops, all of it. The user sees a worse assistant with no explanation and no indication of
which model they are on.

This is a footgun that pays for nothing. Remove the preset. (The `isLocalModel` ordering bug is
worth fixing regardless — any provider whose catalogue happens to include an id colliding with an
SDK model can trip the same wire.)

---

## 3. Should OpenRouter be added?

**Yes — as a documented base URL, not as a preset.**

OpenRouter is an OpenAI-compatible aggregator over 400+ models from 60+ providers. It needs no code:

| | |
|---|---|
| Base URL | `https://openrouter.ai/api/v1` |
| Model list | `GET /api/v1/models` → `{data: [{id, name, …}]}` — exactly the shape `fetchProviderModels` already parses |
| Chat | `POST /api/v1/chat/completions`, standard OpenAI body |
| Auth | `Authorization: Bearer <key>` — what the generic path already sends |
| Tool calling | OpenAI-format, supported |

It works today, unchanged, by selecting the OpenAI-compatible preset and pasting that URL. Two
notes:

- Synapse's URL builder handles it correctly: the base ends in `/v1`, so it produces
  `…/api/v1/models` and `…/api/v1/chat/completions` rather than doubling the segment
  (`providerModels.ts:158, 358`). Good.
- `fetchProviderModels`'s capability heuristics will be poor here — it regexes ids for
  `gpt-4o|claude-3|vision` and hardcodes `supportsTools = true` for every non-Ollama model
  (`providerModels.ts:186-190`). OpenRouter's model objects carry real capability metadata
  (`supported_parameters`, modality info). Reading those fields is a small, contained improvement
  that also benefits every other OpenAI-compatible backend that returns them.

**Why it is worth naming explicitly in the docs:** OpenRouter is the natural answer to "I want a
model that isn't Claude and isn't running on my laptop" — one key, hundreds of models, no
per-provider work. It makes the *absence* of OpenAI/Azure/Anthropic presets a non-issue rather than
a gap. Give it a row in the README table and a wiki paragraph.

---

## 4. Recommended end state

### Dropdown: three entries

| Label | Value | Path | Auth |
|---|---|---|---|
| **Ollama** | `ollama` | Native Ollama API | Optional bearer token (new field) |
| **OpenAI-compatible** | `openai` | `{base}/v1/…` | `Authorization: Bearer` |
| **Azure OpenAI** | `azure` | `{base}/v1/…` | `api-key` |

Two code paths, one header variant. `other-openai`, `foundry-local` and `anthropic` map to
`openai` on load so existing `data.json` files keep working (except `anthropic`, which should map to
`openai` **and** show a one-time notice explaining that Anthropic models belong in the Claude auth
section — otherwise the migration silently changes which key is used).

### Documentation: one table that beats the dropdown

| Provider | Preset | Base URL | Notes |
|---|---|---|---|
| Ollama (local) | Ollama | `http://localhost:11434` | Default. Capabilities auto-detected |
| Ollama Cloud | Ollama | `http://localhost:11434` | `ollama signin`, pull a `:cloud` model |
| OpenRouter | OpenAI-compatible | `https://openrouter.ai/api/v1` | 400+ models, one key |
| OpenAI | OpenAI-compatible | `https://api.openai.com` | |
| LM Studio | OpenAI-compatible | `http://localhost:1234/v1` | |
| llama.cpp server | OpenAI-compatible | `http://localhost:8080/v1` | |
| vLLM | OpenAI-compatible | `http://localhost:8000/v1` | |
| Groq / Together / DeepSeek / Mistral | OpenAI-compatible | provider's `/v1` | |
| Foundry Local | OpenAI-compatible | `http://localhost:<port>/v1` | Port from `foundry service status`. **Model list unavailable** — enter the id manually |
| Azure OpenAI | Azure OpenAI | `https://<res>.openai.azure.com/openai` | v1 API only; classic deployment URLs unsupported |
| Anthropic | — | — | Use **Settings → Claude → API key**, not this section |

Note this table supports *more* providers than today's dropdown, with *less* code.

---

## 5. Fix the docs alongside the code

`README.md:155-160` currently claims:

| Provider | Preset | Default endpoint |
|---|---|---|
| Ollama | `ollama` | `http://localhost:11434/v1` |
| Microsoft Foundry Local | `openai` | Local Foundry model server |
| Other OpenAI-compatible | `openai` | Any compatible endpoint |

Three inaccuracies: the Ollama default is `http://localhost:11434` with **no** `/v1`
(`settings.ts:142`); Foundry Local and "other" select `foundry-local` / `other-openai` in the actual
UI, not `openai`; and `azure` and `anthropic` are absent from the README entirely while present in
the dropdown. `README.md:323` also states the Provider default is "Anthropic" when the code default
is `'ollama'` (`settings.ts:141`).

Adopting §4 makes the README correct almost by construction — which is the strongest argument for
it.

---

## 6. The addition that actually matters: a Messages-API gateway

None of the above changes what a local model can *do*. That is governed by which engine runs it,
not which preset selects it. The automation report covers this in full; the provider-facing summary:

- Every OpenAI-compatible preset feeds the hand-rolled ReAct loop in `executeLocalProviderQuery`:
  no skills, no subagents, no sessions, no permission modes, no streaming, no cost accounting.
- `ANTHROPIC_BASE_URL` points the Claude CLI at any endpoint speaking the **Anthropic Messages API**
  (`/v1/messages`). A local translating proxy (LiteLLM being the usual choice) accepts that and
  forwards to Ollama — at which point a local model runs through the *same* Agent SDK as Claude,
  with the full feature set.
- `agentService.buildEnv(forLocalModel = true)` (`:372-397`) is a half-built version of this **and
  it is wrong** — it sets `ANTHROPIC_BASE_URL` to Ollama's OpenAI-shaped `/v1`, which the CLI cannot
  speak. It is dead code today (no caller passes `true`), so nothing is broken, but it must not be
  revived as-is.

**Recommendation:** delete that branch now, and add a separate, clearly-labelled setting — not a
provider preset — for a Messages-API gateway URL:

> **Advanced → Local agent gateway (optional).** URL of a proxy exposing the Anthropic Messages API
> (e.g. LiteLLM) in front of your local models. When set, local models run through the full Claude
> agent engine — skills, subagents, sessions, permissions — instead of the simplified local loop.

This is the one place where extra work buys something no preset can: real feature parity between a
Claude-backed and an Ollama-backed Synapse.

---

## 7. Suggested sequence

1. Merge `other-openai` → `openai`; relabel to "OpenAI-compatible". *(no behaviour change)*
2. Remove `foundry-local`; rewrite `wiki/Local-Models-Foundry.md` for the generic preset with the
   "Test can't list models" caveat.
3. Remove `anthropic`; add the migration notice. Fix the `isLocalModel` ordering bug
   (`agentService.ts:534`) regardless.
4. Fix `azure`'s placeholder and description; confirm `GET /openai/v1/models` hands-on.
5. Surface Ollama auth (bearer token field), parallelise `/api/show`, re-key the cache.
6. Rewrite the README provider table (§4) and add the OpenRouter row.
7. Add `providerModels.test.ts` — table-driven over `{preset, baseUrl}` asserting the constructed
   URL, headers and body. Every finding in this report would have been caught by it.
8. Delete `buildEnv`'s `forLocalModel` branch; scope the gateway setting (§6) separately.

Steps 1–4 are net **deletions**. The dropdown gets shorter, the code gets shorter, the docs get
longer and truer, and the number of genuinely supported providers goes up.

---

## Related

- [`2026-09-03-automation-model-beyond-triggers.md`](2026-09-03-automation-model-beyond-triggers.md)
  — §4 "One engine, two backends", the Direct/Gateway tiering.
- [`2026-09-03-open-source-readiness-code-quality.md`](2026-09-03-open-source-readiness-code-quality.md)
  — §3.1, §3.2, §3.5.
- [`../decisions/2026-06-15-byok-model-discovery.md`](../decisions/2026-06-15-byok-model-discovery.md)
- [`../decisions/2026-06-26-ollama-cloud-models-support.md`](../decisions/2026-06-26-ollama-cloud-models-support.md)

## Sources

- [Ollama API reference](https://github.com/ollama/ollama/blob/main/docs/api.md) ·
  [structured outputs](https://docs.ollama.com/capabilities/structured-outputs)
- [Anthropic — OpenAI SDK compatibility](https://platform.claude.com/docs/en/api/openai-sdk)
- [Foundry Local REST API reference](https://learn.microsoft.com/en-us/azure/foundry-local/reference/reference-rest)
- [Azure OpenAI v1 API lifecycle](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)
- [OpenRouter — one API for 400+ models](https://www.deployhq.com/blog/openrouter-practical-guide-teams)
- [LiteLLM — Claude Code with non-Anthropic models](https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models)
