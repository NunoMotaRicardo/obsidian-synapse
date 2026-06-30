# Ollama test pass — step-by-step instructions

Reference: [decision record](decisions/2026-06-25-ollama-support-and-multimodal.md) |
[issue #24](https://github.com/NunoMotaRicardo/obsidian-copilot/issues/24)

## Prerequisites

1. **Ollama running:** `ollama serve` (or already running as a service).
2. **Models pulled:** at minimum one chat model and one vision model.
   - Chat + tool use: `ollama pull qwen3` (or `qwen2.5`)
   - Vision + chat: needs a model with `vision` capability (check with `ollama show <model>` — look for `vision` in capabilities).
3. **Plugin deployed:** run `/deploy-test` or `npm run build` and copy artifacts to the vault plugin folder.
4. **Verify Ollama is reachable:** `curl http://localhost:11434/api/tags` should return your model list.

> **Note:** These instructions use `_synapse/` as the vault customization folder.

---

## Setup — configure Synapse for Ollama

1. Open Obsidian → **Settings** → **Synapse**.
2. Under **Models**, set:
   - **Provider**: `Ollama`
   - **Base URL**: `http://localhost:11434/v1` (should auto-fill)
   - **Model name**: your model name exactly as Ollama reports it (e.g., `gemma4:latest`)
   - **API key / Bearer token**: leave empty (Ollama needs no auth by default)
   - **Wire API**: `Completions`
3. Click **Test** → should show "Connected — found N model(s)."
4. Under **Inline operations**, set the **Model** dropdown to match (or leave as default if it auto-populated).

---

## Test matrix

Record results in `wiki/ollama-test-results.md` using this template per test:

```
### Test N — <name>
- **Model:** <model name>
- **Result:** PASS / FAIL / PARTIAL
- **Attempts:** N/3
- **Notes:** <what happened, errors observed, latency, quality>
```

**Acceptance bar (Level B):** Feature works consistently across 3 attempts. Errors are handled gracefully (clear error message, no crash).

---

### Test 1 — Chat (basic conversation)

**Goal:** Verify basic chat works end-to-end.

1. Open the Synapse panel (brain icon in the sidebar, or `Ctrl+Shift+P` → "Open Synapse").
2. Type a simple message: `What is the capital of Portugal?`
3. Wait for the response.
4. Send a follow-up: `Tell me one interesting fact about it.`
5. Repeat 3 times total (close and reopen the session each time).

**Pass if:** Response received each time, no errors, conversation context works (follow-up is contextual).

**Watch for:**
- Connection errors or timeouts
- Empty responses
- Model name mismatch errors
- Session creation failures

---

### Test 2 — Streaming

**Goal:** Verify tokens stream incrementally (not delivered as one block).

1. Open Synapse chat.
2. Ask something that requires a longer response: `Write a short paragraph about the history of Lisbon.`
3. Watch the response area — tokens should appear word-by-word or chunk-by-chunk.

**Pass if:** Tokens visibly stream in real-time. The response completes cleanly (no truncation, no hanging spinner).

**Watch for:**
- Response appearing all at once (streaming broken, falls back to blocking)
- Spinner stuck after response appears complete
- `finish_reason` errors in the developer console (`Ctrl+Shift+I`)
- Partial response followed by an error

---

### Test 3 — Tool use

**Goal:** Verify the model can call tools (MCP servers or vault tools).

**Prerequisite:** You need at least one tool available. Options:

- **Option A — MCP tool:** If `_synapse/.mcp.json` exists in your vault with MCP server definitions, those tools should be available.
- **Option B — Built-in vault access:** Ask the model to do something that requires reading vault content. Try: `List the files in my vault.`
- **Option C — Skip if no tools configured:** Note "skipped — no tools available" and move on. Tool use depends on model capability.

1. In Synapse chat, ask the model to use a tool.
2. If a permission dialog appears, approve it.
3. Verify the tool result is incorporated into the response.

**Pass if:** Model calls the tool, result is returned and used in the response. Or, if the model doesn't support tool use, a graceful fallback (text response without tool call, no crash).

---

### Test 4 — Editor: Rewrite

**Goal:** Verify the "Rewrite" context menu action works.

1. Open any note with a paragraph of text.
2. Select a sentence or paragraph.
3. Right-click → **Synapse** → **Rewrite**.
4. Wait for the replacement.

**Pass if:** Selected text is replaced with a rewritten version. Notice shows "Synapse: Rewrite — done."

---

### Test 5 — Editor: Edit the note

**Goal:** Verify the free-form "Edit the note" action.

1. Open a note with some content.
2. Right-click (no selection) → **Synapse** → **Edit the note**.
3. In the modal, type: `Add a summary section at the top`
4. Click **Apply**.

**Pass if:** Note is updated with a summary section added. Original content preserved.

---

### Test 6 — Editor: Structure and refine

**Goal:** Verify the "Structure and refine" action.

1. Open a note with unstructured content (plain text, no headings).
2. Right-click (no selection) → **Synapse** → **Structure and refine**.
3. Optionally enter a template type (e.g., `meeting notes`), or leave blank.
4. Click **Structure**.

**Pass if:** Note is restructured with headings, lists, and improved formatting. Original information preserved.

---

### Test 7 — Triggers

**Goal:** Verify file-change triggers fire and the model responds.

**Prerequisite:** Create a trigger file in the vault under `_synapse/triggers/greet.trigger.md`:

```markdown
---
name: greet
description: Greet when a new daily note is created
glob: "Daily Notes/**/*.md"
event: create
enabled: true
---

Say "Hello! A new daily note was created: {{file.name}}" and suggest three things to journal about today.
```

1. Reload the plugin (or restart Obsidian) so the trigger is picked up.
2. Create a new file matching the glob pattern.
3. The Synapse panel should open and respond.

**Pass if:** Trigger fires, Synapse responds with contextual content.

---

### Test 8 — Agents

**Goal:** Verify custom agent personas work.

**Prerequisite:** Create an agent file in the vault under `_synapse/agents/pirate.md`:

```markdown
---
name: pirate
description: A pirate assistant
model: gemma4:latest
---

You are a pirate assistant. Always respond in pirate speak, using "arr", "matey", "shiver me timbers", and nautical vocabulary. Be helpful but stay in character.
```

1. Reload the plugin so the agent is picked up.
2. Open Synapse chat.
3. Select the "pirate" agent from the agent dropdown.
4. Ask: `What's the weather like today?`

**Pass if:** Response is in pirate character. The agent's system message is applied.

---

### Test 9 — Image: Extract content (file explorer)

**Goal:** Verify image content extraction from the file explorer.

**Prerequisite:** Need a vision-capable model. If capabilities don't include `vision`, skip this test and note "skipped — model does not support vision."

1. Add an image to your vault (e.g., a screenshot with text).
2. Embed it in a note: `![[screenshot.png]]`
3. In the file explorer, right-click the image file → **Synapse** → **Insert extracted content below**.
4. The active note must contain the embed — the extracted text is inserted below it.

**Pass if:** Extracted text/content appears below the image embed in the note.

---

### Test 10 — Image: Mermaid conversion (file explorer)

**Goal:** Verify image-to-Mermaid diagram conversion.

**Prerequisite:** Same as Test 9 — needs a vision-capable model.

1. Add a diagram/flowchart image to the vault.
2. Embed it in a note.
3. Right-click the image in file explorer → **Synapse** → **Convert to mermaid diagram below**.

**Pass if:** A ````mermaid` code block is inserted below the embed. The diagram roughly represents the image content.

---

## After testing

1. Record all results in `wiki/ollama-test-results.md`.
2. For any FAIL or PARTIAL results, note the error messages and developer console output.

## Switching models mid-test

To test with a different model:

1. **Settings** → **Synapse** → **Models** → change **Model name** to the new model (e.g., `qwen3:latest`).
2. Click **Test** to verify connection.
3. Start a new chat session.
