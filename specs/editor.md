# editor

Source: `src/editor/editorMenu.ts`, `src/modals/editModal.ts`, `src/modals/promptModal.ts`,
`src/utils.ts`.

## Shared helpers

- **`promptModal()`** (`src/modals/promptModal.ts`) — generic one-input prompt modal used by the
  five editor-menu modals (new note, new canvas, ask about image, edit the note, structure and
  refine): description `<p>` (`.synapse-menu-modal-desc`), optional label
  (`.synapse-modal-label`), `TextComponent` (`.synapse-modal-text-input`), go/cancel buttons
  (`.modal-button-container`, go = `.mod-cta`), Enter wired via `modal.scope.register`, input
  focused on open. Returns the `Modal` (callers may `close()` it inside their callback).
  Options: `title`, `description`, `placeholder`, `goLabel`, optional `inputLabel`,
  optional `requiredNotice` (an empty trimmed input shows this Notice and does **not** submit —
  used by the ask-about-image and edit-the-note prompts), optional `focusInput`, and `onSubmit`
  receiving the trimmed text after the modal closes.
- **`getCmView(view)`** (`src/utils.ts`) — the single home for the
  `(view as unknown as {editor?: {cm?: EditorView}}).editor?.cm` cast: unwraps the CM6
  `EditorView` from a `MarkdownView`, returning `undefined` when absent. Used by `main.ts`
  command handlers and the editor menu instead of inline casts.
- **`resolveFilePath(file)`** (`src/utils.ts`) — absolute OS path of a picked/dropped `File`:
  tries Electron `webUtils.getPathForFile` (via the shared `nodeRequire` shim), falls back to
  the legacy `File.path`, else `''`. Used by the chat input's attach and drop handlers.

## Context-menu actions (`editorMenu.ts`)

Right-click → Synapse. With a selection: Edit (modal), Rewrite, Proofread, Use synonyms,
Minor/Major revise, Describe, Answer, Explain, Expand, Summarize, Chat with synapse. Without: Edit the note, Structure and refine, Chat.
File/folder explorer menu: notes get Edit the note/Structure and refine/Chat with Synapse; folders
get New note/New canvas/New summary note/Semantic search/Chat with Synapse; images get extraction
(insert below/replace)/convert to Mermaid/ask about image.

When the cursor is on a line containing an image embed (`![[image.png]]` or `![alt](path.png)`),
the Synapse submenu shows image-specific actions instead of the normal selection/note actions:
**Extract text below**, **Convert to mermaid below**, and **Ask about image** (a modal for a
free-form question whose response is inserted below the embed). These reuse the same module-level
functions as the file-explorer image menu (`extractImageContent()`, `convertToMermaidBelow()`),
so there is no duplication. The image embed is detected via regex matching for common image
extensions in both wikilink and standard markdown syntaxes, then resolved through
`app.metadataCache.getFirstLinkpathDest()` (and validated against `IMAGE_EXTENSIONS`).

- Quick actions route through handler agents via `AgentService.inlineChat()`, naming their call
  shape with the `profile:` option (issue #230 — `INLINE_CHAT_PROFILES` in `agentService.ts`;
  see "Wiring `inlineChat()`'s callers" in `agent-service.md`). Two profiles here:
  - **Text transforms** (selection actions, note edit, structure/refine, new note/canvas,
    folder summary — and the edit modal's variation runs): content is inlined in the prompt, so
    they pass `profile: 'textTransform'` (`tools: []`, `maxTurns: 1`) — deterministic, fast, and
    immune to the model wandering off into tool use.
    The plugin applies the result itself (editor dispatch / `vault.create`).
  - **Vision/image actions** (extract text, ask about image → `profile: 'readOnly'`
    (`tools: ['Read']`); convert to mermaid → `profile: 'attended'` (`maxTurns: 10`, default
    toolset for skill access)): the model must `Read` the image path inlined in the prompt, so
    their system messages explicitly instruct reading the path first.
  Text actions bind to the utility agent (`featureAgents.inline`, empty by default — no explicit
  `agent` is passed, so the SDK's own default applies), while image actions bind to the vision-capable
  agent (`featureAgents.vision`, also empty by default). There is no hard dependency on any
  specific local model (Claude default).
- The Edit modal offers task/tone/format/length/choices controls and N alternatives.

## Constraints

- Text-transform paths (`profile: 'textTransform'` → `tools: []` + `maxTurns: 1`) must stay fast:
  no usable skills or MCP
  servers (nothing is permitted to call them), minimal system prompt. This does not apply to the
  vision/image profile — convert-to-mermaid deliberately runs with the default toolset so it can
  use the vault's mermaid skill (see above).
- The Edit modal never writes to the note until the user picks a choice (`useBtn` → `onChoose`).
  Other quick actions (Rewrite/Proofread/etc., Edit the note, Structure and refine, new note/canvas,
  folder summary) apply their result immediately on response — editor dispatch or `vault.create` —
  with no separate accept step.
