# editor

Source: `src/editor/editorMenu.ts`, `src/modals/promptModal.ts`, `src/utils.ts`.

## Shared helpers

- **`promptModal()`** (`src/modals/promptModal.ts`) — generic one-input prompt modal used by the
  editor-menu modals (new note, new canvas, ask about image, edit/insert with Synapse): description `<p>`
  (`.synapse-menu-modal-desc`), optional label (`.synapse-modal-label`), `TextComponent`
  (`.synapse-modal-text-input`) — or, with `multiline: true`, a `TextAreaComponent`
  (`.synapse-modal-textarea`; Enter submits, Shift+Enter inserts a newline), go/cancel buttons
  (`.modal-button-container`, go = `.mod-cta`), Enter wired via `modal.scope.register`, input
  focused on open. Returns the `Modal` (callers may `close()` it inside their callback).
  Options: `title`, `description`, `placeholder`, `goLabel`, optional `inputLabel`,
  optional `requiredNotice` (an empty trimmed input shows this Notice and does **not** submit —
  used by the ask-about-image and edit/insert prompts), optional `multiline`, optional `focusInput`, and `onSubmit`
  receiving the trimmed text after the modal closes.
- **`getCmView(view)`** (`src/utils.ts`) — the single home for the
  `(view as unknown as {editor?: {cm?: EditorView}}).editor?.cm` cast: unwraps the CM6
  `EditorView` from a `MarkdownView`, returning `undefined` when absent. Used by `main.ts`
  command handlers and the editor menu instead of inline casts.
- **`resolveFilePath(file)`** (`src/utils.ts`) — absolute OS path of a picked/dropped `File`:
  tries Electron `webUtils.getPathForFile` (via the shared `nodeRequire` shim), falls back to
  the legacy `File.path`, else `''`. Used by the chat input's attach and drop handlers.

## Context-menu actions (`editorMenu.ts`)

Right-click shows ONE flat item: **Edit with Synapse** when text is selected, **Insert with Synapse**
when not (`showEditOrInsertModal()`). It opens a small modal (`promptModal` with `multiline: true`)
for free-form instructions; empty input shows a Notice and keeps the modal open. The model sees the
whole note: for edits the selection is wrapped in `<<<SELECTION_START>>>`/`<<<SELECTION_END>>>`
markers and it returns only the replacement text; for inserts the cursor is marked `<<<CURSOR>>>`
and it returns only the text to insert. The result is applied directly (no preview; Ctrl+Z
undoes), with the selection's leading/trailing whitespace preserved on edits and the result trimmed
on inserts. The range and note text are captured when the modal opens; if the note changed while
the model ran (for edits: the original text is no longer at that range), nothing is applied and the
result is copied to the clipboard with a Notice. A persistent Notice ("editing…"/"inserting…")
shows while running. The command palette entry `edit-or-insert` ("Edit or insert with Synapse")
opens the same modal.
File/folder explorer menu: notes get a flat **Chat with Claude Synapse** item; folders
get New note/New canvas/New summary note/Semantic search/Chat with Synapse; images get extraction
(insert below/replace)/convert to Mermaid/ask about image.

When the cursor is on a line containing an image embed (`![[image.png]]` or `![alt](path.png)`),
an additional **Claude Synapse** submenu (alongside the flat Edit/Insert item) shows image-specific actions:
**Extract text below**, **Convert to mermaid below**, and **Ask about image** (a modal for a
free-form question whose response is inserted below the embed). These reuse the same module-level
functions as the file-explorer image menu (`extractImageContent()`, `convertToMermaidBelow()`),
so there is no duplication. The image embed is detected via regex matching for common image
extensions in both wikilink and standard markdown syntaxes, then resolved through
`app.metadataCache.getFirstLinkpathDest()` (and validated against `IMAGE_EXTENSIONS`).

- Quick actions route through handler agents via `AgentService.inlineChat()`, naming their call
  shape with the `profile:` option (issue #230 — `INLINE_CHAT_PROFILES` in `agentService.ts`;
  see "Wiring `inlineChat()`'s callers" in `agent-service.md`). Two profiles here:
  - **Text transforms** (edit/insert with Synapse, new note/canvas, folder summary): content is inlined in the prompt, so
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

## Constraints

- Text-transform paths (`profile: 'textTransform'` → `tools: []` + `maxTurns: 1`) must stay fast:
  no usable skills or MCP
  servers (nothing is permitted to call them), minimal system prompt. This does not apply to the
  vision/image profile — convert-to-mermaid deliberately runs with the default toolset so it can
  use the vault's mermaid skill (see above).
- Edit/insert, new note/canvas and folder summary apply their result immediately on response —
  editor dispatch or `vault.create` — with no separate accept step. Edit/insert only dispatch when
  the captured range is still valid; otherwise the result goes to the clipboard.
