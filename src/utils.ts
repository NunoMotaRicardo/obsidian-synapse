import {MarkdownView, type MarkdownFileInfo} from 'obsidian';
import type {EditorView} from '@codemirror/view';
import {nodeRequire} from './nodeRequire';

/**
 * Resolve the absolute OS path of a `File` obtained from a file picker or an OS
 * drag-and-drop (issue #238). Prefers Electron's `webUtils.getPathForFile`; when
 * it is unavailable (or `require` is missing outside the Electron renderer) falls
 * back to the legacy `File.path` property, and to `''` when neither yields a path.
 * Shared by the chat input's attach and drop handlers (`src/view/inputArea.ts`),
 * which previously duplicated this fallback chain.
 */
export function resolveFilePath(file: File): string {
	try {
		const webUtils = (nodeRequire?.('electron') as {webUtils?: {getPathForFile: (f: File) => string}} | undefined)?.webUtils;
		if (webUtils?.getPathForFile) {
			return webUtils.getPathForFile(file);
		}
	} catch {
		// `require('electron')` unavailable outside the Electron renderer —
		// fall through to the legacy property below.
	}
	return (file as unknown as {path: string}).path || '';
}

/**
 * Unwrap the CM6 `EditorView` backing an Obsidian `MarkdownView` (issue #238) —
 * the single home for the `(view as unknown as {editor?: {cm?: EditorView}}).editor?.cm`
 * cast, used by `main.ts` command handlers and `src/editor/editorMenu.ts` instead
 * of inline casts. Returns `undefined` when the view has no CM6 editor (e.g. the
 * view is not yet mounted). Accepts the `MarkdownView | MarkdownFileInfo` union
 * that Obsidian's `editorCallback` passes as its `view` argument.
 */
export function getCmView(view: MarkdownView | MarkdownFileInfo): EditorView | undefined {
	return (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
}