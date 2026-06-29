# editor

Source: `src/editor/editorMenu.ts`, `src/modals/editModal.ts`.

## Context-menu actions (`editorMenu.ts`)

Right-click → Synapse. With a selection: Edit (modal), Rewrite, Proofread, Use synonyms,
Minor/Major revise, Describe, Answer, Explain, Expand, Summarize, Chat with synapse. Without: Edit the note, Structure and refine, Chat.
File/folder explorer menu: note edit, folder summary note, image extraction/mermaid.

When the cursor is on a line containing an image embed (`![[image.png]]` or `![alt](path.png)`),
the Synapse submenu shows image-specific actions instead of the normal selection/note actions:
**Extract text below**, **Convert to mermaid below**, and **Ask about image** (a modal for a
free-form question whose response is inserted below the embed). These reuse the same module-level
functions as the file-explorer image menu (`extractImageContent()`, `convertToMermaidBelow()`),
so there is no duplication. The image embed is detected via regex matching for common image
extensions in both wikilink and standard markdown syntaxes, then resolved through
`app.metadataCache.getFirstLinkpathDest()` (and validated against `IMAGE_EXTENSIONS`).

- Quick actions replace text in place using the **inline operations model** via
  `CopilotService.chat()` (ephemeral session, `approveAll`). When a BYOK provider is active,
  `chat()` and `inlineChat()` auto-inject the `provider` config (type, baseUrl, apiKey,
  bearerToken, wireApi) and `streaming` flag, so inline actions work with non-GitHub providers
  (Ollama, Foundry Local, OpenAI, Azure, Anthropic, etc.) without any additional wiring (#25).
- The Edit modal offers task/tone/format/length/choices controls and N alternatives.

## Constraints

- Inline paths must stay fast: no skills, no MCP servers, minimal system prompt.
- Never write to the note until the user accepts (modal pick).
