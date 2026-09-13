import type {App} from 'obsidian';
import type SynapsePlugin from '../main';
import type {SynapseView} from '../synapseView';

/**
 * Narrow bridge a `src/view/*` controller receives instead of the whole `SynapseView`.
 *
 * Composition refactor (per `.docs/research/2026-09-11-view-composition-refactor.md`):
 * each view module becomes a single controller class owning its feature state; it
 * reaches the shared view state through this interface, widened only as conversions
 * prove the need. `SynapseView` implements it.
 */
export interface ViewContext {
	readonly app: App;
	readonly plugin: SynapsePlugin;
	readonly chatContainer: HTMLElement;
	/** The owning view — typed as the full `SynapseView` for shared state still owned there. */
	readonly view: SynapseView;
	/** True while a chat run is streaming (view-owned streaming state). */
	isStreaming: boolean;
	/** Scroll the chat container to the bottom if the user is already near it (see `SynapseView.scrollToBottom`). */
	scrollToBottom(): void;
	/** Absolute on-disk vault root (delegates to `getVaultBasePath(this.app)`). */
	getVaultBasePath(): string;
	/** Session's working directory (chat panel). */
	getWorkingDirectory(): string;
	/** Whether the session config is dirty and `ensureSession()` must rebuild before the next send. */
	configDirty: boolean;
}

// `BackgroundSession` — a chat session kept running while the user views another session —
// moved to `./backgroundSession` as a first-class class that owns its own state (audit §4,
// issue #237). Import it from there.
