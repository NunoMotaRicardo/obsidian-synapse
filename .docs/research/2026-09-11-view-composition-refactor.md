# View composition refactor — working notes

Working notes for the `claude/view-composition` branch converting `src/view/*` from
prototype injection into `SynapseView` to real composition. Not a decision record —
the durable record goes in `specs/chat-view.md` at the end.

## Goal

Per the 2026-09-11 audit (`2026-09-11-codebase-design-audit.md`, recommendation 1):
replace the `declare module` + prototype-assignment pattern with real composition, so
the wiring is compiler-checked and the source-text wiring test is deletable.

## Target shape

Each `src/view/<module>.ts` exports a single class `XxxController` with:

```ts
export class ConfigToolbarController {
	// Private module-owned state (was: public fields on SynapseView)
	private selectedAgent = '';
	// ...

	constructor(private view: ViewContext) {}

	build(parent: HTMLElement): void { ... }   // was: proto.buildX = ...
	// module methods, private unless another module needs them
}

// module-scope instance accessor
export function configToolbar(view: ViewContext): ConfigToolbarController
```

`SynapseView` creates and owns exactly one instance per module in `buildUI()` and holds
it as `readonly xxx: XxxController` — a real reference, not a merged interface:

```ts
class SynapseView extends ItemView {
	readonly configToolbar!: ConfigToolbarController;  // created in buildUI()
}
```

## ViewContext — the narrow bridge

Each controller receives a **small interface** (defined in `view/types.ts`), not the
whole `SynapseView`. Start narrow; widen only when a conversion genuinely needs to.
The base shape (grows as modules convert):

```ts
export interface ViewContext {
	readonly app: App;
	readonly plugin: SynapsePlugin;
	// Chat-panel state the view owns (stays on SynapseView — it is the session
	// orchestrator; only the *feature* UI state moves into controllers):
	readonly chatContainer: HTMLElement;
	getVaultBasePath(): string;
	getWorkingDirectory(): string;
	configDirty: boolean;               // settable by controllers
	// …per-module needs are added when its conversion proves them
}
```

Rules:

1. **State moves to the controller that owns it.** If a field's only writers/readers
   live in one module (e.g. `searchAgent`, `isSearching`, all `search*El` DOM refs), it
   becomes private on that controller. Cross-module state (e.g. `messages`,
   `sessionToolGrants`, streaming lifecycle) stays on `SynapseView` for now and is
   reached through `ViewContext` — this refactor moves the *pattern*, not all state
   ownership.
2. **Method calls across modules go through the owner's controller reference**, e.g.
   `this.view.sidebar.renderSessionList()` or `this.configToolbar.updateToolsBadge()` —
   never through `SynapseView` as a bag of methods.
3. **External callers** (`editorMenu.ts`, `editModal.ts`, `main.ts`) keep calling
   public methods on `SynapseView` (which delegates to the owning controller) so
   those files need zero changes: `view.setPromptText(...)` stays, implemented as
   `this.inputArea.setPromptText(...)`. Do not touch `src/editor/` or `src/modals/`.
4. **`this`-bindings:** controllers are plain classes; callbacks registered on DOM
   elements must preserve `this` — use arrow-function methods or explicit `.bind()`.
5. **Don't rename public methods or CSS classes.** Tests assert on class names
   (`synapse-search-composer` etc.) and method names. Keep every existing identifier
   unless the wiring test's deletion justifies it.
6. **Keep comments.** The long doc comments are the codebase's institutional
   knowledge. Move them with their code.

## Conversion order

1. `searchPanel.ts` (reference conversion — least coupled)
2. `configToolbar.ts`
3. `chatRenderer.ts`
4. `inputArea.ts`
5. `sessionSidebar.ts` (most coupled — last)

Each step: convert → `npm run build` → `npx vitest run` → commit. The
`viewInjectionWiring.test.ts` test is deleted at the end of step 1 (it guards the old
pattern; the composition makes it compiler-checked). Other source-text tests
(`editorial*`) keep passing because CSS classes and method names don't change —
except `proto.updateStateLine = function (): void` (editorialMastheadComposer line 146),
which will need a one-line update in step 4, and `searchMode` assertions (line 152-154)
which stay valid because the method names remain.

## Test handling

- `test/viewInjectionWiring.test.ts` — delete after step 1 (guards the old pattern).
- `test/editorial*.test.ts` — keep; they assert CSS classes/strings, which survive.
  Only the `proto.updateStateLine` assertion changes (step 4).
- `test/inlineChatCallerWiring.test.ts` — untouched (about editorMenu).