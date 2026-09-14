import {Editor, EventRef, MarkdownView, Menu, Notice, TFile, TFolder, normalizePath} from 'obsidian';
import type {EditorView} from '@codemirror/view';
import SynapsePlugin, {SYNAPSE_ICON_ID} from '../main';
import type {SdkPluginConfig} from '../agentService';
import {getVaultBasePath, getSynapsePluginConfig} from '../vaultPaths';
import {getCmView} from '../utils';
import {promptModal} from '../modals/promptModal';

import {SYNAPSE_VIEW_TYPE, SynapseView, registerInlineSession} from '../synapseView';
import {stripErrorPrefix} from '../toolErrors';
import {EditModal} from '../modals/editModal';
import {TASKS, TEXT_ACTION_SYSTEM_MESSAGE} from '../tasks';
import type {TextTask} from '../tasks';
import type {SelectionInfo} from '../types';
/** Format an error for display in a Notice. */
function formatErrorForNotice(error: unknown): string {
	return `Claude Synapse: error — ${stripErrorPrefix(String(error))}`;
}

// Re-export for consumers that still import from editorMenu
export {TEXT_ACTION_SYSTEM_MESSAGE} from '../tasks';
export type {TextTask as TextAction} from '../tasks';

/**
 * Register a "Synapse" submenu on the editor right-click context menu.
 * Shows selection-level actions when text is selected, or note-level
 * actions when nothing is selected.
 */
export function registerEditorMenu(plugin: SynapsePlugin): void {
	plugin.registerEvent(
		(plugin.app.workspace as unknown as {on: (name: string, cb: (menu: Menu, editor: Editor, view: MarkdownView) => void) => EventRef}).on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
			const cmView = getCmView(view);
			if (!cmView) return;

			menu.addItem((item) => {
				item.setTitle('Claude Synapse')
					.setIcon(SYNAPSE_ICON_ID);

				const submenu: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();
				buildSynapseMenu(submenu, plugin, cmView);
			});
		}),
	);
}

/**
 * Open a markdown file and resolve its CM6 EditorView.
 * Returns null if the view cannot be obtained.
 */
async function openFileAndGetView(plugin: SynapsePlugin, file: TFile): Promise<EditorView | null> {
	const leaf = plugin.app.workspace.getLeaf();
	await leaf.openFile(file);
	const view = leaf.view;
	if (view instanceof MarkdownView) {
		return getCmView(view) ?? null;
	}
	return null;
}

/**
 * Register a "Synapse" submenu on the vault file-explorer context menu.
 * Shows note-level actions for markdown files and folder-level actions for folders.
 */
export function registerFileMenu(plugin: SynapsePlugin): void {
	plugin.registerEvent(
		(plugin.app.workspace as unknown as {on: (name: string, cb: (menu: Menu, abstractFile: TFile | TFolder) => void) => EventRef}).on('file-menu', (menu: Menu, abstractFile: TFile | TFolder) => {
			if (abstractFile instanceof TFolder) {
				buildFolderMenu(menu, plugin, abstractFile);
				return;
			}
			if (!(abstractFile instanceof TFile)) return;

			// Image files
			if (IMAGE_EXTENSIONS.has(abstractFile.extension.toLowerCase())) {
				buildImageMenu(menu, plugin, abstractFile);
				return;
			}

			// Markdown files only
			if (abstractFile.extension !== 'md') return;

			menu.addItem((item) => {
				item.setTitle('Claude Synapse')
					.setIcon(SYNAPSE_ICON_ID);

				const submenu: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();

				submenu.addItem((si) =>
					si.setTitle('Edit the note')
						.setIcon('pencil')
						.onClick(async () => {
							const cmView = await openFileAndGetView(plugin, abstractFile);
							if (cmView) showEditNoteModal(plugin, cmView);
						}),
				);
				submenu.addItem((si) =>
					si.setTitle('Structure and refine')
						.setIcon('layout-list')
						.onClick(async () => {
							const cmView = await openFileAndGetView(plugin, abstractFile);
							if (cmView) showStructureModal(plugin, cmView);
						}),
				);

				submenu.addSeparator();

				submenu.addItem((si) =>
					si.setTitle('Chat with Claude Synapse')
						.setIcon(SYNAPSE_ICON_ID)
						.onClick(async () => {
							const leaf = plugin.app.workspace.getLeaf();
							await leaf.openFile(abstractFile);
							openSynapseView(plugin);
						}),
				);


			});
		}),
	);
}

/* ── Folder context menu ──────────────────────────────────────── */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

/** Add Synapse submenu items for a folder in the vault tree. */
function buildFolderMenu(menu: Menu, plugin: SynapsePlugin, folder: TFolder): void {
	menu.addItem((item) => {
		item.setTitle('Claude Synapse')
			.setIcon(SYNAPSE_ICON_ID);

		const submenu: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();

		submenu.addItem((si) =>
			si.setTitle('New note')
				.setIcon('file-plus')
				.onClick(() => showNewNoteModal(plugin, folder)),
		);
		submenu.addItem((si) =>
			si.setTitle('New canvas')
				.setIcon('layout-dashboard')
				.onClick(() => showNewCanvasModal(plugin, folder)),
		);
		submenu.addItem((si) =>
			si.setTitle('New summary note')
				.setIcon('file-text')
				.onClick(() => void createSummaryNote(plugin, folder)),
		);

		submenu.addSeparator();

		submenu.addItem((si) =>
			si.setTitle('Semantic search')
				.setIcon('search')
				.onClick(() => void openSynapseSearchWithScope(plugin, folder.path)),
		);
		submenu.addItem((si) =>
			si.setTitle('Chat with Claude Synapse')
				.setIcon(SYNAPSE_ICON_ID)
				.onClick(() => void openSynapseViewWithScope(plugin, folder.path)),
		);
	});
}

/* ── Folder actions ─────────────────────────────────────────── */

/**
 * Generate a unique filename in the folder, based on a stem and extension
 * (issue #238 — consolidated from the former identical `uniqueFileName` and
 * `uniqueNoteName` pair; callers pass `'md'` or `'canvas'`).
 */
function uniqueName(folder: TFolder, stem: string, extension: string): string {
	const existing = new Set(
		folder.children
			.filter((c): c is TFile => c instanceof TFile && c.extension === extension)
			.map((f) => f.basename),
	);
	if (!existing.has(stem)) return stem;
	for (let i = 2; ; i++) {
		const candidate = `${stem} ${i}`;
		if (!existing.has(candidate)) return candidate;
	}
}

/** Show a modal asking for an optional template type, then create a new note. */
function showNewNoteModal(plugin: SynapsePlugin, folder: TFolder): void {
	promptModal(plugin.app, {
		title: 'New note',
		description: 'Optionally specify a template type for the note:',
		placeholder: 'Ex: daily notes, meeting notes, project brief',
		goLabel: 'Create',
		onSubmit: (templateType) => void createNewNote(plugin, folder, templateType),
	});
}

async function createNewNote(plugin: SynapsePlugin, folder: TFolder, templateType: string): Promise<void> {
	if (!plugin.agentService) { new Notice('Synapse is not configured.'); return; }

	const templateClause = templateType
		? `The note should follow a "${templateType}" template. `
		: '';

	const notice = new Notice('Synapse: creating note…', 0);
	try {
		// Ask the LLM for a suggested filename and structured content
		const {content: result, sessionId} = await plugin.agentService.inlineChat({
			app: plugin.app,
			prompt:
				`Create a new Markdown note. ${templateClause}` +
				`Return the output in exactly this format:\n` +
				`TITLE: <short descriptive title for the note>\n` +
				`---\n` +
				`<note content in Markdown>`,
			agent: plugin.settings.featureAgents?.inline || undefined,
			plugins: getVaultPlugins(plugin),
			systemMessage:
				'You are a note creation assistant. When asked to create a note, return a title line ' +
				'followed by the separator --- and then the note body in Markdown. ' +
				'Do not include markdown code fences or extra explanations.',
			profile: 'textTransform',
		});
		registerInlineSession(plugin, sessionId, `New note in ${folder.name}`);

		if (!result) { notice.hide(); new Notice('Synapse: no response.'); return; }

		// Parse title and content
		let title = 'New note';
		let content = result.trim();
		const sepIndex = content.indexOf('---');
		if (sepIndex !== -1) {
			const header = content.slice(0, sepIndex).trim();
			const titleMatch = header.match(/^TITLE:\s*(.+)/i);
			if (titleMatch && titleMatch[1]) {
				title = titleMatch[1].trim();
			}
			content = content.slice(sepIndex + 3).trim();
		}

		// Sanitise title for filename
		title = title.replace(/[\\/:*?"<>|]/g, '').trim() || 'New note';
		const basename = uniqueName(folder, title, 'md');
		const filePath = normalizePath(`${folder.path}/${basename}.md`);

		const newFile = await plugin.app.vault.create(filePath, content);
		notice.hide();
		new Notice(`Claude Synapse: created "${basename}".`);

		// Open the new note
		const leaf = plugin.app.workspace.getLeaf();
		await leaf.openFile(newFile);
	} catch (e) {
		notice.hide();
		new Notice(formatErrorForNotice(e));
	}
}

/** Show a modal asking for an optional template type, then create a new canvas. */
function showNewCanvasModal(plugin: SynapsePlugin, folder: TFolder): void {
	promptModal(plugin.app, {
		title: 'New canvas',
		description: 'Optionally specify a template type for the canvas:',
		placeholder: 'Ex: brainstorming, project plan, mind map',
		goLabel: 'Create',
		onSubmit: (templateType) => void createNewCanvas(plugin, folder, templateType),
	});
}

async function createNewCanvas(plugin: SynapsePlugin, folder: TFolder, templateType: string): Promise<void> {
	if (!plugin.agentService) { new Notice('Synapse is not configured.'); return; }

	const templateClause = templateType
		? `The canvas should follow a "${templateType}" template. `
		: '';

	const notice = new Notice('Synapse: creating canvas\u2026', 0);
	try {
		const {content: result, sessionId} = await plugin.agentService.inlineChat({
			app: plugin.app,
			prompt:
				`Create an Obsidian canvas. ${templateClause}` +
				`Return the output in exactly this format:\n` +
				`TITLE: <short descriptive title for the canvas>\n` +
				`---\n` +
				`<valid Obsidian canvas JSON>`,
			agent: plugin.settings.featureAgents?.inline || undefined,
			plugins: getVaultPlugins(plugin),
			systemMessage:
				'You are a canvas creation assistant for Obsidian. When asked to create a canvas, return a title line ' +
				'followed by the separator --- and then valid Obsidian .canvas JSON.\n\n' +
				'Obsidian canvas format is a JSON object with "nodes" and "edges" arrays.\n' +
				'Each node has: id (unique string), type ("text", "group", "file", or "link"), ' +
				'x, y (number), width, height (number). Text nodes also have a "text" field (Markdown string). ' +
				'Group nodes have a "label" field. Link nodes have a "url" field.\n' +
				'Each edge has: id (unique string), fromNode, toNode (node id strings), ' +
				'fromSide, toSide ("top"|"bottom"|"left"|"right"), and optionally "label" (string).\n' +
				'Layout nodes with enough spacing (at least 50px gaps). Use reasonable sizes (width 250-400, height 100-250).\n' +
				'Do not include markdown code fences or extra explanations. Return ONLY the title and JSON.',
			profile: 'textTransform',
		});
		registerInlineSession(plugin, sessionId, `New canvas in ${folder.name}`);

		if (!result) { notice.hide(); new Notice('Synapse: no response.'); return; }

		// Parse title and content
		let title = 'New canvas';
		let content = result.trim();
		const sepIndex = content.indexOf('---');
		if (sepIndex !== -1) {
			const header = content.slice(0, sepIndex).trim();
			const titleMatch = header.match(/^TITLE:\s*(.+)/i);
			if (titleMatch && titleMatch[1]) {
				title = titleMatch[1].trim();
			}
			content = content.slice(sepIndex + 3).trim();
		}

		// Validate that content is valid JSON with nodes array
		try {
			const parsed: unknown = JSON.parse(content);
			if (
				typeof parsed !== 'object' || parsed === null ||
				!('nodes' in parsed) || !Array.isArray((parsed as {nodes?: unknown}).nodes)
			) {
				throw new Error('Missing nodes array');
			}
			content = JSON.stringify(parsed, null, '\t');
		} catch (e) {
			notice.hide();
			new Notice(`Claude Synapse: invalid canvas format \u2014 ${String(e)}`);
			return;
		}

		// Sanitise title for filename
		title = title.replace(/[\\/:*?"<>|]/g, '').trim() || 'New canvas';
		const basename = uniqueName(folder, title, 'canvas');
		const filePath = normalizePath(`${folder.path}/${basename}.canvas`);

		const newFile = await plugin.app.vault.create(filePath, content);
		notice.hide();
		new Notice(`Claude Synapse: created "${basename}".`);

		// Open the new canvas
		const leaf = plugin.app.workspace.getLeaf();
		await leaf.openFile(newFile);
	} catch (e) {
		notice.hide();
		new Notice(formatErrorForNotice(e));
	}
}

async function createSummaryNote(plugin: SynapsePlugin, folder: TFolder): Promise<void> {
	if (!plugin.agentService) { new Notice('Synapse is not configured.'); return; }

	// Gather markdown notes in the folder
	const mdFiles = folder.children
		.filter((c): c is TFile => c instanceof TFile && c.extension === 'md')
		.sort((a, b) => a.basename.localeCompare(b.basename));

	if (mdFiles.length === 0) {
		new Notice('Synapse: no notes found in this folder.');
		return;
	}

	const notice = new Notice('Synapse: creating summary…', 0);
	try {
		// Read all notes (truncate each to keep within context limits)
		const MAX_PER_NOTE = 2000;
		const noteContents: string[] = [];
		for (const f of mdFiles) {
			let text = await plugin.app.vault.cachedRead(f);
			if (text.length > MAX_PER_NOTE) text = text.slice(0, MAX_PER_NOTE) + '\n…(truncated)';
			noteContents.push(`## ${f.basename}\n${text}`);
		}

		const combined = noteContents.join('\n\n---\n\n');

		const {content: result, sessionId} = await plugin.agentService.inlineChat({
			app: plugin.app,
			prompt:
				`Summarize the following ${mdFiles.length} notes from the folder "${folder.name}". ` +
				`Produce a single cohesive summary note in Markdown that captures the key topics, ` +
				`themes, and important details across all notes.\n\n${combined}`,
			agent: plugin.settings.featureAgents?.inline || undefined,
			plugins: getVaultPlugins(plugin),
			systemMessage:
				'You are a note summarisation assistant. Return ONLY the summary note in Markdown. ' +
				'Do not include markdown code fences, introductory text, or explanations.',
			profile: 'textTransform',
		});
		registerInlineSession(plugin, sessionId, `Summary of ${folder.name}`);

		if (!result) { notice.hide(); new Notice('Synapse: no response.'); return; }

		const basename = uniqueName(folder, `${folder.name} — Summary`, 'md');
		const filePath = normalizePath(`${folder.path}/${basename}.md`);

		const newFile = await plugin.app.vault.create(filePath, result.trim());
		notice.hide();
		new Notice(`Claude Synapse: created "${basename}".`);

		const leaf = plugin.app.workspace.getLeaf();
		await leaf.openFile(newFile);
	} catch (e) {
		notice.hide();
		new Notice(formatErrorForNotice(e));
	}
}

/**
 * Run a text action on selected text in a CM6 EditorView directly.
 * Used by both the gutter indicator menu and the context menu.
 */
export async function runSelectionAction(
	plugin: SynapsePlugin,
	view: EditorView,
	selectedText: string,
	action: TextTask,
): Promise<void> {
	if (!plugin.agentService) {
		new Notice('Synapse is not configured.');
		return;
	}

	const notice = new Notice(`Claude Synapse: ${action.label}…`, 0);

	try {
		const result = await runActionPrompt(plugin, action, selectedText);

		if (!result) {
			notice.hide();
			new Notice('Synapse: no response received.');
			return;
		}

		// Replace the selection in the CM6 view
		const sel = view.state.selection.main;
		view.dispatch({
			changes: {from: sel.from, to: sel.to, insert: result.trim()},
		});
		notice.hide();
		new Notice(`Claude Synapse: ${action.label} — done.`);
	} catch (e) {
		notice.hide();
		console.error('Synapse: editor action error', e);
		new Notice(formatErrorForNotice(e));
	}
}

/**
 * Core helper: send the action prompt to the agent and return the result.
 */
async function runActionPrompt(
	plugin: SynapsePlugin,
	action: TextTask,
	selectedText: string,
): Promise<string | null> {
	if (!plugin.agentService) return null;

	const {content: result, sessionId} = await plugin.agentService.inlineChat({
		app: plugin.app,
		prompt: action.prompt(selectedText),
		agent: plugin.settings.featureAgents?.inline || undefined,
		plugins: getVaultPlugins(plugin),
		systemMessage: TEXT_ACTION_SYSTEM_MESSAGE,
		permissionMode: plugin.settings.toolApproval === 'allow' ? 'bypassPermissions' : 'default',
		profile: 'textTransform',
	});
	registerInlineSession(plugin, sessionId, action.label);

	return result ?? null;
}

/* ── Image context menu ───────────────────────────────────────── */

const IMAGE_EXT_PATTERN = Array.from(IMAGE_EXTENSIONS).join('|');

/** Regex for wikilink image embed: ![[filename.ext]] or ![[filename.ext|alt]] */
const WIKILINK_IMAGE_RE = new RegExp(`!\\[\\[([^\\]|]+\\.(?:${IMAGE_EXT_PATTERN}))(?:\\|[^\\]]*)?\\]\\]`, 'i');
/** Regex for standard markdown image embed: ![alt](path.ext) */
const MARKDOWN_IMAGE_RE = new RegExp(`!\\[[^\\]]*\\]\\(([^)]+\\.(?:${IMAGE_EXT_PATTERN}))\\)`, 'i');

/**
 * Check whether the cursor line contains an image embed and resolve the
 * referenced file. Returns the resolved TFile or null.
 */
function resolveImageEmbedOnLine(
	plugin: SynapsePlugin,
	view: EditorView,
): {file: TFile; embed: {from: number; to: number}} | null {
	const sel = view.state.selection.main;
	const line = view.state.doc.lineAt(sel.head);
	const lineText = line.text;

	let linkpath: string | null = null;
	let matchFrom = 0;
	let matchLength = 0;
	const wikiMatch = WIKILINK_IMAGE_RE.exec(lineText);
	if (wikiMatch && wikiMatch[1]) {
		linkpath = wikiMatch[1];
		matchFrom = wikiMatch.index;
		matchLength = wikiMatch[0].length;
	} else {
		const mdMatch = MARKDOWN_IMAGE_RE.exec(lineText);
		if (mdMatch && mdMatch[1]) {
			linkpath = mdMatch[1];
			matchFrom = mdMatch.index;
			matchLength = mdMatch[0].length;
		}
	}
	if (!linkpath) return null;

	const activeFile = plugin.app.workspace.getActiveFile();
	const resolved = plugin.app.metadataCache.getFirstLinkpathDest(linkpath, activeFile?.path ?? '');
	if (!resolved || !IMAGE_EXTENSIONS.has(resolved.extension.toLowerCase())) return null;
	return {
		file: resolved,
		embed: {from: line.from + matchFrom, to: line.from + matchFrom + matchLength},
	};
}

/**
 * Populate a menu with image-specific Synapse actions for editor context menu.
 * Shown when the cursor is on a line containing an image embed.
 */
function buildEditorImageMenu(menu: Menu, plugin: SynapsePlugin, file: TFile, embed: {from: number; to: number}): void {
	menu.addItem((item) =>
		item.setTitle('Extract text below')
			.setIcon('arrow-down-to-line')
			.onClick(() => void extractAndInsertBelow(plugin, file, embed)),
	);
	menu.addItem((item) =>
		item.setTitle('Convert to Mermaid below')
			.setIcon('git-fork')
			.onClick(() => void convertToMermaidBelow(plugin, file, embed)),
	);
	menu.addItem((item) =>
		item.setTitle('Ask about image')
			.setIcon('message-circle')
			.onClick(() => showAskAboutImageModal(plugin, file, embed)),
	);
}

/** "Ask about image" — user enters a free-form prompt about the image. */
function showAskAboutImageModal(plugin: SynapsePlugin, file: TFile, embedHint?: {from: number; to: number}): void {
	promptModal(plugin.app, {
		title: 'Ask about image',
		description: `Ask a question about ${file.name}:`,
		placeholder: 'Ex: what does this diagram show?',
		goLabel: 'Ask',
		requiredNotice: 'Please enter a question.',
		onSubmit: (prompt) => void askAboutImage(plugin, file, prompt, embedHint),
	});
}

/** Send a user prompt about an image and insert the response below the embed. */
async function askAboutImage(plugin: SynapsePlugin, file: TFile, userPrompt: string, embedHint?: {from: number; to: number}): Promise<void> {
	if (!plugin.agentService) { new Notice('Synapse is not configured.'); return; }

	const ctx = getActiveEditorAndEmbed(plugin, file, embedHint);
	if (!ctx) return;
	const {cmView, embed} = ctx;

	const absPath = getAbsolutePath(plugin, file);
	const notice = new Notice('Synapse: asking about image…', 0);
	try {
		const {content: result, sessionId} = await plugin.agentService.inlineChat({
			app: plugin.app,
			prompt: `${userPrompt}\n\n---\nAttached image: ${file.name}\nPath: ${absPath}`,
			agent: plugin.settings.featureAgents?.vision || undefined,
			plugins: getVaultPlugins(plugin),
			systemMessage:
				'You are an image analysis assistant. Read the image at the provided path with your Read tool, ' +
				'then answer the user’s question about it. ' +
				'Return your answer as clean Markdown. Do not include markdown code fences or introductory text.',
			profile: 'readOnly',
		});
		registerInlineSession(plugin, sessionId, `Ask: ${userPrompt.slice(0, 30)}`);

		const raw = result?.trim() ?? null;
		if (!raw) { notice.hide(); new Notice('Synapse: no response.'); return; }

		insertBelowEmbed(cmView, embed, raw);
		notice.hide();
		new Notice('Synapse: response inserted.');
	} catch (e) {
		notice.hide();
		new Notice(formatErrorForNotice(e));
	}
}

/** Add Synapse submenu items for an image file in the vault tree. */
function buildImageMenu(menu: Menu, plugin: SynapsePlugin, file: TFile): void {
	menu.addItem((item) => {
		item.setTitle('Claude Synapse')
			.setIcon(SYNAPSE_ICON_ID);

		const submenu: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();

		submenu.addItem((si) =>
			si.setTitle('Insert extracted content below')
				.setIcon('arrow-down-to-line')
				.onClick(() => void extractAndInsertBelow(plugin, file)),
		);
		submenu.addItem((si) =>
			si.setTitle('Replace with extracted content')
				.setIcon('replace')
				.onClick(() => void extractAndReplace(plugin, file)),
		);
		submenu.addItem((si) =>
			si.setTitle('Convert to Mermaid diagram below')
				.setIcon('git-fork')
				.onClick(() => void convertToMermaidBelow(plugin, file)),
		);
		submenu.addItem((si) =>
			si.setTitle('Ask about image')
				.setIcon('message-circle')
				.onClick(() => showAskAboutImageModal(plugin, file)),
		);
	});
}

/** Get the absolute OS path for a vault file. */
function getAbsolutePath(plugin: SynapsePlugin, file: TFile): string {
	const basePath = getVaultBasePath(plugin.app);
	return basePath + '/' + file.path;
}

/** Get the SDK plugin configs to pass to inlineChat so the SDK can discover vault artifacts. */
function getVaultPlugins(plugin: SynapsePlugin): SdkPluginConfig[] {
	return getSynapsePluginConfig(plugin.app);
}

/** Extract content from an image by sending it to the LLM. */
async function extractImageContent(plugin: SynapsePlugin, file: TFile): Promise<string | null> {
	if (!plugin.agentService) { new Notice('Synapse is not configured.'); return null; }

	const absPath = getAbsolutePath(plugin, file);

	const {content: result, sessionId} = await plugin.agentService.inlineChat({
		app: plugin.app,
		prompt:
			`Extract all visible content from this image and convert it to well-structured Markdown. ` +
			`Include text, tables, lists, diagrams descriptions, and any other meaningful content. ` +
			`If the image contains a diagram or chart, describe it in detail.\n\n---\n` +
			`Attached image: ${file.name}\nPath: ${absPath}`,
		agent: plugin.settings.featureAgents?.vision || undefined,
		plugins: getVaultPlugins(plugin),
		systemMessage:
			'You are an image content extraction assistant. Read the image at the provided path with your Read tool, ' +
			'then extract all visible content from it ' +
			'and return it as clean Markdown. Do not include markdown code fences, introductory text, or explanations. ' +
			'Return only the extracted content.',
		profile: 'readOnly',
	});
	registerInlineSession(plugin, sessionId, `Extract ${file.name}`);

	return result?.trim() ?? null;
}

/**
 * Find the image embed reference in the active note's EditorView.
 * Searches for `![[filename]]` and `![...](path)` patterns.
 * Returns {from, to} of the full embed match, or null.
 */
function findImageEmbed(view: EditorView, file: TFile): {from: number; to: number} | null {
	const doc = view.state.doc.toString();

	// Try wikilink: ![[filename]] or ![[path/filename]]
	const wikiPatterns = [
		`![[${file.path}]]`,
		`![[${file.name}]]`,
		`![[${file.basename}]]`,
	];
	for (const pattern of wikiPatterns) {
		const idx = doc.indexOf(pattern);
		if (idx !== -1) return {from: idx, to: idx + pattern.length};
	}

	// Try wikilink with alt text: ![[filename|alt]]
	const wikiAltRegex = new RegExp(
		`!\\[\\[(?:${escapeRegex(file.path)}|${escapeRegex(file.name)}|${escapeRegex(file.basename)})\\|[^\\]]*\\]\\]`
	);
	const wikiAltMatch = wikiAltRegex.exec(doc);
	if (wikiAltMatch) return {from: wikiAltMatch.index, to: wikiAltMatch.index + wikiAltMatch[0].length};

	// Try standard markdown: ![alt](path)
	const mdRegex = new RegExp(
		`!\\[[^\\]]*\\]\\((?:${escapeRegex(file.path)}|${escapeRegex(file.name)})\\)`
	);
	const mdMatch = mdRegex.exec(doc);
	if (mdMatch) return {from: mdMatch.index, to: mdMatch.index + mdMatch[0].length};

	return null;
}

/** Escape special regex characters in a string. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the active EditorView and the embed range for `file`.
 * Returns `null` and shows an appropriate Notice when either is unavailable.
 */
function getActiveEditorAndEmbed(
	plugin: SynapsePlugin,
	file: TFile,
	embedHint?: {from: number; to: number},
): {cmView: EditorView; embed: {from: number; to: number}} | null {
	const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	if (!activeView) {
		new Notice('Synapse: open a note that contains this image first.');
		return null;
	}
	const cmView = getCmView(activeView);
	if (!cmView) return null;

	const embed = embedHint ?? findImageEmbed(cmView, file);
	if (!embed) {
		new Notice(`Claude Synapse: could not find a reference to "${file.name}" in the active note.`);
		return null;
	}
	return {cmView, embed};
}

/** Insert `text` on a new paragraph after the line that contains `embed`. */
function insertBelowEmbed(cmView: EditorView, embed: {from: number; to: number}, text: string): void {
	const line = cmView.state.doc.lineAt(embed.to);
	cmView.dispatch({changes: {from: line.to, insert: '\n\n' + text}});
}

/** Extract image content and insert it below the embed in the active note. */
async function extractAndInsertBelow(plugin: SynapsePlugin, file: TFile, embedHint?: {from: number; to: number}): Promise<void> {
	const ctx = getActiveEditorAndEmbed(plugin, file, embedHint);
	if (!ctx) return;
	const {cmView, embed} = ctx;

	const notice = new Notice('Synapse: extracting image content…', 0);
	try {
		const content = await extractImageContent(plugin, file);
		if (!content) { notice.hide(); new Notice('Synapse: no content extracted.'); return; }

		insertBelowEmbed(cmView, embed, content);
		notice.hide();
		new Notice('Synapse: extracted content inserted.');
	} catch (e) {
		notice.hide();
		new Notice(formatErrorForNotice(e));
	}
}

/** Extract image content and replace the embed in the active note. */
async function extractAndReplace(plugin: SynapsePlugin, file: TFile): Promise<void> {
	const ctx = getActiveEditorAndEmbed(plugin, file);
	if (!ctx) return;
	const {cmView, embed} = ctx;

	const notice = new Notice('Synapse: extracting image content…', 0);
	try {
		const content = await extractImageContent(plugin, file);
		if (!content) { notice.hide(); new Notice('Synapse: no content extracted.'); return; }

		cmView.dispatch({
			changes: {from: embed.from, to: embed.to, insert: content},
		});
		notice.hide();
		new Notice('Synapse: image replaced with extracted content.');
	} catch (e) {
		notice.hide();
		new Notice(formatErrorForNotice(e));
	}
}

/** Convert an image to a Mermaid diagram and insert it below the embed in the active note. */
async function convertToMermaidBelow(plugin: SynapsePlugin, file: TFile, embedHint?: {from: number; to: number}): Promise<void> {
	const ctx = getActiveEditorAndEmbed(plugin, file, embedHint);
	if (!ctx) return;
	const {cmView, embed} = ctx;

	if (!plugin.agentService) { new Notice('Synapse is not configured.'); return; }

	const absPath = getAbsolutePath(plugin, file);
	const notice = new Notice('Synapse: converting image to Mermaid diagram…', 0);
	try {
		const {content: result, sessionId} = await plugin.agentService.inlineChat({
			app: plugin.app,
			prompt:
				`Analyze this image and convert it into a Mermaid diagram. ` +
				`Use the mermaid skill available in the vault to produce valid Mermaid syntax. ` +
				`Choose the most appropriate diagram type (e.g. flowchart, sequenceDiagram, classDiagram, erDiagram, gantt, mindmap, etc.) ` +
				`that best represents the content of the image. ` +
				`Return only the Mermaid code block, with no additional explanation.\n\n---\n` +
				`Attached image: ${file.name}\nPath: ${absPath}`,
			agent: plugin.settings.featureAgents?.vision || undefined,
			plugins: getVaultPlugins(plugin),
			systemMessage:
				'You are an expert at converting visual diagrams and charts into Mermaid diagram syntax. Use <br> to break lines instead of \\n for obsidian compatibility. ' +
				'Read the image at the provided path with your Read tool first. ' +
				'Use the mermaid skill from the vault when available to validate and improve the diagram output. ' +
				'Analyze the provided image and return a single Mermaid code block (wrapped in ```mermaid ... ```) ' +
				'that faithfully represents the structure shown. Do not include any introductory text or explanation.',
			profile: 'attended',
		});
		registerInlineSession(plugin, sessionId, `Mermaid ${file.name}`);

		const raw = result?.trim() ?? null;
		if (!raw) { notice.hide(); new Notice('Synapse: no diagram generated.'); return; }

		// Extract the first ```mermaid fenced block, or wrap bare Mermaid content in a fence
		const fenceMatch = /```mermaid\b[\s\S]*?```/i.exec(raw);
		let mermaid: string;
		if (fenceMatch) {
			mermaid = fenceMatch[0];
		} else {
			// No fence found — check if it looks like raw Mermaid syntax and wrap it
			const looksLikeMermaid = /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|gitGraph|block-beta|xychart-beta)\b/im.test(raw);
			if (!looksLikeMermaid) {
				notice.hide();
				new Notice('Synapse: could not find a valid Mermaid diagram in the response.');
				return;
			}
			mermaid = '```mermaid\n' + raw + '\n```';
		}

		insertBelowEmbed(cmView, embed, mermaid);
		notice.hide();
		new Notice('Synapse: Mermaid diagram inserted.');
	} catch (e) {
		notice.hide();
		new Notice(formatErrorForNotice(e));
	}
}

/* ── Note-level actions ───────────────────────────────────────── */

/** "Edit the note" — user enters a free-form editing prompt. */
export function showEditNoteModal(plugin: SynapsePlugin, view: EditorView): void {
	promptModal(plugin.app, {
		title: 'Edit the note',
		description: 'Describe how the note should be edited:',
		placeholder: 'Ex: convert bullet points to a table',
		goLabel: 'Apply',
		requiredNotice: 'Please enter a prompt.',
		onSubmit: (prompt) => void applyEditNote(plugin, view, prompt),
	});
}

async function applyEditNote(plugin: SynapsePlugin, view: EditorView, userPrompt: string): Promise<void> {
	if (!plugin.agentService) { new Notice('Synapse is not configured.'); return; }
	const doc = view.state.doc.toString();
	const notice = new Notice('Synapse: editing note…', 0);
	try {
		const {content: result, sessionId} = await plugin.agentService.inlineChat({
			app: plugin.app,
			prompt:
				`Apply the following edit instruction to the note and return the FULL updated note.\n\n` +
				`INSTRUCTION:\n${userPrompt}\n\nNOTE:\n${doc}`,
			agent: plugin.settings.featureAgents?.inline || undefined,
			plugins: getVaultPlugins(plugin),
			systemMessage:
				'You are a note editor. When given a note and an edit instruction, return ONLY the updated note content. ' +
				'Do not include explanations, markdown code fences, or introductory text. Return the full note.',
			profile: 'textTransform',
		});
		registerInlineSession(plugin, sessionId, `Edit: ${userPrompt.slice(0, 30)}`);
		if (!result) { notice.hide(); new Notice('Synapse: no response.'); return; }
		view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: result.trim()}});
		notice.hide();
		new Notice('Synapse: note edited.');
	} catch (e) {
		notice.hide();
		new Notice(formatErrorForNotice(e));
	}
}

/** "Structure and refine" — restructures the note with optional template type. */
export function showStructureModal(plugin: SynapsePlugin, view: EditorView): void {
	promptModal(plugin.app, {
		title: 'Structure and refine',
		description: 'The note will be restructured using Markdown and refined for clarity.',
		placeholder: 'Ex: daily notes, meeting notes, project brief',
		goLabel: 'Structure',
		inputLabel: {text: 'Template type (optional):', cls: 'synapse-modal-label'},
		// This modal never focused its input pre-refactor — preserved (#238).
		focusInput: false,
		onSubmit: (templateType) => void applyStructure(plugin, view, templateType),
	});
}

async function applyStructure(plugin: SynapsePlugin, view: EditorView, templateType: string): Promise<void> {
	if (!plugin.agentService) { new Notice('Synapse is not configured.'); return; }
	const doc = view.state.doc.toString();
	const notice = new Notice('Synapse: structuring note…', 0);

	const templateClause = templateType
		? `Structure the note as a "${templateType}" template. `
		: '';

	try {
		const {content: result, sessionId} = await plugin.agentService.inlineChat({
			app: plugin.app,
			prompt:
				`Structure and refine the following note using Markdown. ${templateClause}` +
				`Organise the content with headings, lists, and emphasis where appropriate. ` +
				`Improve clarity and readability while preserving all original information.\n\nNOTE:\n${doc}`,
			agent: plugin.settings.featureAgents?.inline || undefined,
			plugins: getVaultPlugins(plugin),
			systemMessage:
				'You are a note structuring assistant. Return ONLY the restructured note in Markdown. ' +
				'Do not include explanations, markdown code fences, or introductory text. Return the full note.',
			profile: 'textTransform',
		});
		registerInlineSession(plugin, sessionId, 'Structure and refine');
		if (!result) { notice.hide(); new Notice('Synapse: no response.'); return; }
		view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: result.trim()}});
		notice.hide();
		new Notice('Synapse: note structured.');
	} catch (e) {
		notice.hide();
		new Notice(formatErrorForNotice(e));
	}
}

export {type SelectionInfo} from '../types';

/** "Chat with Claude Synapse" — open the sidebar view, optionally with prompt text and selection. */
export function openSynapseView(plugin: SynapsePlugin, promptText?: string, selection?: SelectionInfo): void {
	void (async () => {
		await plugin.activateView();
		if (promptText || selection) {
			const leaves = plugin.app.workspace.getLeavesOfType(SYNAPSE_VIEW_TYPE);
			if (leaves.length > 0 && leaves[0]) {
				const view = leaves[0].view as SynapseView;
				if (promptText) view.setPromptText(promptText);
				if (selection) view.addSelectionAttachment(promptText ?? '', selection);
			}
		}
	})();
}

/** Open the Synapse chat view with a specific folder set as scope. */
async function openSynapseViewWithScope(plugin: SynapsePlugin, folderPath: string): Promise<void> {
	await plugin.activateView();
	const leaves = plugin.app.workspace.getLeavesOfType(SYNAPSE_VIEW_TYPE);
	if (leaves.length > 0 && leaves[0]) {
		const view = leaves[0].view as SynapseView;
		view.setScope([folderPath]);
		view.setWorkingDir(folderPath);
	}
}

/** Open the Synapse search tab scoped to a specific folder. */
async function openSynapseSearchWithScope(plugin: SynapsePlugin, folderPath: string): Promise<void> {
	await plugin.activateView();
	const leaves = plugin.app.workspace.getLeavesOfType(SYNAPSE_VIEW_TYPE);
	if (leaves.length > 0 && leaves[0]) {
		const view = leaves[0].view as SynapseView;
		view.openSearchWithScope(folderPath);
	}
}

/**
 * Populate a menu with Synapse actions. Used by both the context menu
 * and the gutter synapse-button to keep behaviour consistent.
 *
 * @param menu      The Obsidian Menu (or submenu) to populate.
 * @param plugin    The Synapse plugin instance.
 * @param view      The CM6 EditorView.
 */
export function buildSynapseMenu(menu: Menu, plugin: SynapsePlugin, view: EditorView): void {
	const sel = view.state.selection.main;
	const hasSelection = !sel.empty;

	// ── Image embed on cursor line — show image actions ──
	const imageResult = resolveImageEmbedOnLine(plugin, view);
	if (imageResult) {
		buildEditorImageMenu(menu, plugin, imageResult.file, imageResult.embed);
		return;
	}

	if (hasSelection) {
		// ── Selection: text-transform actions ──
		const selectedText = view.state.sliceDoc(sel.from, sel.to);

		// Edit — advanced editing with tone, length, choices
		menu.addItem((item) =>
			item.setTitle('Edit')
				.setIcon('pencil-line')
				.onClick(() => {
					new EditModal(plugin, selectedText, (result) => {
						const currentSel = view.state.selection.main;
						view.dispatch({
							changes: {from: currentSel.from, to: currentSel.to, insert: result},
						});
					}).open();
				}),
		);
		menu.addSeparator();

		for (const action of TASKS) {
			menu.addItem((item) =>
				item.setTitle(action.label)
					.setIcon(action.icon)
					.onClick(() => void runSelectionAction(plugin, view, selectedText, action)),
			);
		}
	} else {
		// ── No selection: note-level actions ──
		menu.addItem((item) =>
			item.setTitle('Edit the note')
				.setIcon('pencil')
				.onClick(() => showEditNoteModal(plugin, view)),
		);
		menu.addItem((item) =>
			item.setTitle('Structure and refine')
				.setIcon('layout-list')
				.onClick(() => showStructureModal(plugin, view)),
		);
	}

	menu.addSeparator();

	menu.addItem((item) =>
		item.setTitle('Chat with Claude Synapse')
			.setIcon(SYNAPSE_ICON_ID)
			.onClick(() => {
				if (hasSelection) {
					const text = view.state.sliceDoc(sel.from, sel.to);
					const startLine = view.state.doc.lineAt(sel.from);
					const endLine = view.state.doc.lineAt(sel.to);
					const activeFile = plugin.app.workspace.getActiveFile();
					const filePath = activeFile?.path;
					const fileName = activeFile?.name ?? 'unknown';
					openSynapseView(plugin, text, {
						filePath,
						fileName,
						startLine: startLine.number,
						startChar: sel.from - startLine.from,
						endLine: endLine.number,
						endChar: sel.to - endLine.from,
					});
				} else {
					openSynapseView(plugin);
				}
			}),
	);


}
