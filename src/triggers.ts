import {normalizePath, TFile, TAbstractFile} from 'obsidian';
import type SynapsePlugin from './main';
import type {TriggerConfig, TriggerEvent} from './types';
import {scanTriggers} from './configWriter';
import {SYNAPSE_FOLDER} from './settings';

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Simple glob matcher for vault-relative paths.
 *
 * Supports:
 * - `*` matches any characters except `/`
 * - `**` matches any path segments (including nested)
 * - Literal path prefixes (e.g. `inbox/` matches `inbox/note.md`)
 * - Combination patterns like `inbox/*.md` or `projects/**​/notes/*.md`
 */
export function matchGlob(pattern: string, path: string): boolean {
	// Normalize both sides: trim, forward slashes, no leading/trailing slash
	const p = pattern.replace(/\\/g, '/').replace(/^\/|\/$/g, '');
	const f = path.replace(/\\/g, '/').replace(/^\/|\/$/g, '');

	// Empty pattern matches everything
	if (!p) return true;

	// Literal prefix match: pattern ending with `/` matches any file under that prefix
	if (pattern.endsWith('/') && !p.includes('*')) {
		return f.startsWith(p + '/') || f === p;
	}

	// Convert glob to regex
	const regexStr = globToRegex(p);
	return new RegExp('^' + regexStr + '$').test(f);
}

/**
 * Convert a glob pattern string to a regex source string.
 * Handles `**`, `*`, and escapes all other regex-special chars.
 */
function globToRegex(pattern: string): string {
	let result = '';
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i]!;
		if (ch === '*') {
			if (pattern[i + 1] === '*') {
				// `**` — match any path segments
				// Consume trailing `/` if present (e.g. `**/`)
				if (pattern[i + 2] === '/') {
					result += '(?:.+/)?';
					i += 3;
				} else {
					result += '.*';
					i += 2;
				}
			} else {
				// `*` — match within a single segment (no `/`)
				result += '[^/]*';
				i += 1;
			}
		} else if (ch === '?') {
			result += '[^/]';
			i += 1;
		} else {
			// Escape regex-special characters
			result += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			i += 1;
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// TriggerWatcher
// ---------------------------------------------------------------------------

/** Debounce interval in milliseconds for per-file event collapsing. */
const DEBOUNCE_MS = 500;

/** Delay before reloading trigger configs after _synapse/triggers/ changes. */
const CONFIG_RELOAD_MS = 1000;

/**
 * Watches vault events and fires matching triggers.
 *
 * - Registers vault event listeners via `plugin.registerEvent()` for clean unload.
 * - Debounces rapid events on the same file (500ms collapse window).
 * - Excludes files inside `_synapse/` to avoid feedback loops.
 * - Reloads trigger configs when `_synapse/triggers/` changes.
 * - On match: logs to console. Actual execution is wired in a later issue.
 */
export class TriggerWatcher {
	private plugin: SynapsePlugin;
	private triggers: TriggerConfig[] = [];
	private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private configReloadTimer: ReturnType<typeof setTimeout> | null = null;
	private started = false;

	constructor(plugin: SynapsePlugin) {
		this.plugin = plugin;
	}

	/**
	 * Load triggers and register vault event listeners.
	 * All listeners are registered via `plugin.registerEvent()` so Obsidian
	 * cleans them up on plugin unload automatically.
	 */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		await this.loadTriggers();

		const triggersFolder = normalizePath(`${SYNAPSE_FOLDER}/triggers`);

		// Helper: process a vault event for a given file path
		const handleEvent = (eventType: TriggerEvent, filePath: string) => {
			const normalized = normalizePath(filePath);

			// Exclude files inside _synapse/ to avoid feedback loops
			const synapseBase = normalizePath(SYNAPSE_FOLDER);
			if (normalized.startsWith(synapseBase + '/') || normalized === synapseBase) {
				// But still check if this is a trigger config change for auto-reload
				if (normalized.startsWith(triggersFolder + '/') || normalized === triggersFolder) {
					this.scheduleConfigReload();
				}
				return;
			}

			// Debounce: collapse rapid events on the same file
			this.debounce(normalized, () => {
				this.matchAndFire(eventType, normalized);
			});
		};

		// Register vault event listeners
		this.plugin.registerEvent(
			this.plugin.app.vault.on('create', (file: TAbstractFile) => {
				if (file instanceof TFile) {
					handleEvent('file-created', file.path);
				}
			})
		);

		this.plugin.registerEvent(
			this.plugin.app.vault.on('modify', (file: TAbstractFile) => {
				if (file instanceof TFile) {
					handleEvent('file-modified', file.path);
				}
			})
		);

		this.plugin.registerEvent(
			this.plugin.app.vault.on('delete', (file: TAbstractFile) => {
				if (file instanceof TFile) {
					handleEvent('file-deleted', file.path);
				}
			})
		);

		this.plugin.registerEvent(
			this.plugin.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile) {
					handleEvent('file-renamed', file.path);
					// Also check if old path was a trigger config
					const synapseBase = normalizePath(SYNAPSE_FOLDER);
					if (oldPath.startsWith(normalizePath(`${synapseBase}/triggers`) + '/')) {
						this.scheduleConfigReload();
					}
				}
			})
		);

		console.log(`[synapse] TriggerWatcher started — ${this.triggers.length} trigger(s) loaded`);
	}

	/** Clean up debounce timers. Vault event listeners are cleaned up by Obsidian. */
	stop(): void {
		this.started = false;
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		if (this.configReloadTimer) {
			clearTimeout(this.configReloadTimer);
			this.configReloadTimer = null;
		}
		console.log('[synapse] TriggerWatcher stopped');
	}

	/** Load (or reload) trigger configs from `_synapse/triggers/`. */
	private async loadTriggers(): Promise<void> {
		try {
			const folder = normalizePath(`${SYNAPSE_FOLDER}/triggers`);
			this.triggers = await scanTriggers(this.plugin.app, folder);
			console.log(`[synapse] Loaded ${this.triggers.length} trigger(s)`);
		} catch (e) {
			console.error('[synapse] Failed to load triggers:', e);
			this.triggers = [];
		}
	}

	/** Schedule a debounced reload of trigger configs. */
	private scheduleConfigReload(): void {
		if (this.configReloadTimer) {
			clearTimeout(this.configReloadTimer);
		}
		this.configReloadTimer = setTimeout(() => {
			this.configReloadTimer = null;
			void this.loadTriggers();
		}, CONFIG_RELOAD_MS);
	}

	/**
	 * Debounce an action per file path.
	 * If multiple events fire for the same file within DEBOUNCE_MS, only the
	 * last one executes.
	 */
	private debounce(filePath: string, action: () => void): void {
		const existing = this.debounceTimers.get(filePath);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.debounceTimers.delete(filePath);
			action();
		}, DEBOUNCE_MS);
		this.debounceTimers.set(filePath, timer);
	}

	/**
	 * Check all triggers against the event and file path.
	 * Fires (logs) any that match.
	 */
	private matchAndFire(eventType: TriggerEvent, filePath: string): void {
		for (const trigger of this.triggers) {
			// Skip disabled triggers (enabled defaults to true when omitted)
			if (trigger.enabled === false) continue;

			// Only match event-based triggers (skip schedule-based)
			if (!trigger.event) continue;

			// Event type must match
			if (trigger.event !== eventType) continue;

			// Path glob match (no path pattern = match all files)
			if (trigger.path && !matchGlob(trigger.path, filePath)) continue;

			// Match found — log it (executor comes in issue #51)
			console.log(`[synapse] Trigger "${trigger.name}" fired for ${filePath}`);
		}
	}
}
