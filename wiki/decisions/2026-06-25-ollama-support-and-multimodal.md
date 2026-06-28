# Ollama support audit and multimodal image attachments

## Context

Sidekick already supports Ollama as a BYOK preset (`providerPreset: 'ollama'`), mapped to
the SDK's `'openai'` provider type with a default endpoint of `http://localhost:11434/v1`.
Model discovery via `GET /api/tags` is implemented in `src/providerModels.ts`, and sessions
are created through the standard `ProviderConfig` path in `src/view/sidekickView.ts`.

However, the Ollama integration has **never been end-to-end tested** — the code looks
correct but "should work" is not "works." Separately, the plugin has **no multimodal
support** in the chat panel (the SDK supports image attachments via `{type: 'blob'}` and
`{type: 'file'}`, and the file-explorer already uses file attachments for image extraction
and Mermaid conversion, but the chat panel cannot accept images).

This decision was reached in a `grill-me` elicitation on **2026-06-25**, covering both the
Ollama reliability story and a phased plan for provider-agnostic multimodal image support.

## Decision

### Phase 0 — Structured Ollama test pass

Manual end-to-end testing against two models: **Gemma 4 12B** and **Qwen 2.5 14B** (both
fit in the user's 16 GB VRAM). Acceptance bar is **Level B** (reliable — feature works
consistently across 3+ attempts, errors handled gracefully, no crashes).

Test matrix, in priority order:

| # | Feature | Test | Pass criteria |
|---|---------|------|---------------|
| 1 | Chat | Send a message, get a response | Response received, no errors, 3/3 attempts |
| 2 | Streaming | Watch tokens appear incrementally | Tokens stream in real-time, session completes cleanly |
| 3 | Tool use | Trigger an MCP tool or vault tool from chat | Model calls tool correctly, result returned |
| 4 | Editor: Rewrite | Select text → Rewrite | Text replaced with rewritten version |
| 5 | Editor: Edit the note | Free-form edit prompt | Note updated correctly |
| 6 | Editor: Structure | Structure and refine | Note restructured |
| 7 | Triggers | File-change trigger fires | Trigger executes, model responds |
| 8 | Agents | Custom agent with system message | Agent persona reflected in responses |
| 9 | Image: Extract content | File explorer → extract from image | Content extracted and inserted (vision model only) |
| 10 | Image: Mermaid conversion | File explorer → convert to Mermaid | Valid Mermaid block inserted |
| 11 | Ghost text | Type in editor, wait for completion | Suggestion appears within ~2-5 s |

Results documented in `wiki/ollama-test-results.md` with pass/fail/notes per cell. This
informs all subsequent phases.

### Phase 1 — Core fixes

Fix whatever Phase 0 surfaces: streaming quirks, tool-use failures, error handling.

Add **hybrid connection error handling** for the `ollama` preset: when a connection error
occurs, show a user-friendly Obsidian Notice: *"Could not reach Ollama at localhost:11434.
Is it running? Start it with `ollama serve`."* No retry button, no auto-retry — text-only
notice. The existing Settings → Models **Test** button remains the manual retry mechanism.

Streaming is **left enabled** for Ollama (unlike Foundry Local which has it disabled). If
the test pass reveals streaming issues, they are fixed here rather than disabling streaming
wholesale.

### Phase 2 — Multimodal chat (provider-agnostic)

Add image input to the **chat panel** via three methods:

- **Drag and drop** — drop an image file onto the chat panel
- **Clipboard paste** — Ctrl+V a screenshot or copied image
- **Attachment button** — paperclip/image icon in the chat input bar, opens file picker

**Attachment strategy (hybrid):**

- Vault images (have a file path) → `{type: 'file', path: absolutePath}`
- Clipboard pastes / external images (no vault path) → `{type: 'blob', data: base64, mimeType}`

This avoids unnecessary base64 encoding for on-disk images while supporting clipboard
screenshots. Works with any vision-capable provider — tested with Ollama/Gemma 4 but
provider-agnostic by design.

### Phase 3 — Note-embedded image context (provider-agnostic)

When note content is sent as context, **automatically resolve and attach embedded images**
(`![[image.png]]`, `![](path.png)`) up to a configurable cap.

- **Settings toggle** to disable auto-inclusion (default: enabled)
- **Default cap: 3 images** per message
- Respects SDK `model.capabilities.limits.vision.max_prompt_images` when reported; falls
  back to the plugin-level default (3) otherwise
- First N images in document order; rest silently skipped

### Phase 4 — Image editor actions

Add to the **editor context menu** when cursor is on an image embed (`![[image.png]]`):

1. **Extract text below** — reuses existing `extractImageContent()` implementation from the
   file-explorer menu; inserts extracted content below the embed
2. **Convert to Mermaid** — reuses existing `convertToMermaidBelow()` implementation;
   inserts Mermaid block below the embed
3. **Custom prompt on image** — new action; opens a modal (consistent with "Edit the note"
   UX) where the user types a free-form question about the image; response inserted below
   the embed

Consolidates with existing file-explorer image actions rather than duplicating.

### Phase 5 — Ghost text with Ollama

Test and tune inline completions for local model latency. Lowest priority — local models
are slower than cloud APIs, so ghost text may need model-specific debounce or may not be
practical for all models.

### Phase 6 — Polish (Level C)

Ollama-specific UX improvements based on findings from all earlier phases:

- Friendly error messages for common failure modes
- Model capability detection and surfacing (e.g., "this model does not support tool use")
- Setup guidance for new Ollama users

## Rationale

- **Phase 0 first** because the code audit shows correct-looking plumbing but no evidence
  of real-world testing. Every subsequent phase depends on knowing what actually works.
- **Provider-agnostic multimodal** because the SDK's attachment API already abstracts the
  wire format per provider. Building Ollama-specific image support would duplicate effort
  and need rework when adding multimodal for other providers.
- **Hybrid attachment strategy** because vault images are already on disk (no point
  base64-encoding a large photo) while clipboard pastes have no file path (must be blobs).
  Avoids unnecessary memory pressure on a 16 GB VRAM system.
- **Default cap of 3 images** is conservative for local models where each image consumes
  significant context. Cloud models with higher reported limits get what they support via
  the SDK capability check.
- **Streaming left enabled** because Ollama's OpenAI-compatible layer is more mature than
  Foundry Local's. Fix based on observed behavior, not preemptive workarounds.
- **Hybrid error handling** (option 3) — no upfront polling or status indicators, but when
  a connection error occurs with the `ollama` preset, catch it and show an actionable
  message. Low effort, no startup overhead.

## Scope / Non-goals

- **Not in scope:** Ollama-specific parameters (`num_ctx`, `temperature` overrides, model
  pulling) — enhancement territory, not reliability/multimodal.
- **Not in scope:** Multimodal for non-image content (audio, video).
- **Not in scope:** Changes to the BYOK model discovery flow (covered by the existing
  Phase 1/2 decision in `2026-06-15-byok-model-discovery.md`).
- **Not in scope:** Provider-specific auth header fixes (also covered separately).

## Open questions

- **Ollama streaming chunk format:** Does Ollama's SSE streaming conform closely enough to
  OpenAI's format for the SDK to handle it transparently? Phase 0 will answer this.
- **Tool-use model compatibility:** Which Ollama models reliably support function calling
  through the OpenAI-compatible layer? Phase 0 will test Qwen 2.5 (known good) and
  Gemma 4 (unknown).
- **SDK vision capability reporting:** Does Ollama's OpenAI-compatible layer correctly
  report `max_prompt_images` and `supported_media_types` via the SDK's model capabilities?
  If not, Phase 3's fallback to the plugin default (3) handles it gracefully.

## Related

- [`2026-06-15-byok-model-discovery.md`](2026-06-15-byok-model-discovery.md) — BYOK
  Settings Test button and model datalist (Phase 1/2, separate work stream)
- [`../foundry-local-setup.md`](../foundry-local-setup.md) — Foundry Local setup guide
  (similar local-model UX considerations)
- [`../ai-customization-guide.md`](../ai-customization-guide.md) — vault-local
  customization model (agents, triggers tested in Phase 0)
