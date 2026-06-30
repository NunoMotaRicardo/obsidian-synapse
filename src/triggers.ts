import {App, normalizePath, TFile, TAbstractFile} from 'obsidian';
import type SynapsePlugin from './main';
import type {TriggerConfig, TriggerEvent} from './types';
import {scanTriggers} from './configWriter';
import {SYNAPSE_FOLDER} from './settings';
import {executeTrigger} from './triggerExecutor';

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
 * Resolve a glob pattern to the vault-relative paths of all files it matches.
 *
 * Used by `TriggerScheduler` to expand a scheduled trigger's `path` glob —
 * unlike event triggers, scheduled triggers have no single triggering file,
 * so the glob must be matched against the whole vault instead of one path.
 */
export function resolveGlobFiles(app: App, pattern: string): string[] {
	return app.vault.getFiles()
		.map(file => file.path)
		.filter(path => matchGlob(pattern, path));
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
// Cron matching
// ---------------------------------------------------------------------------

/**
 * Match a single cron field against a numeric value.
 *
 * Supported syntax:
 * - `*`      — matches any value
 * - `N`      — exact match
 * - `N-M`    — inclusive range
 * - `* /N`   — step from 0 (every N)
 * - `N/N`    — step from a start value
 * - Comma-separated list of the above (e.g. `1,15`, `1-5,10`)
 *
 * @param field  The cron field string (one of the five space-separated tokens)
 * @param value  The numeric value extracted from the current time
 * @param min    Minimum valid value for this field (inclusive)
 * @param max    Maximum valid value for this field (inclusive)
 */
function matchField(field: string, value: number, min: number, max: number): boolean {
	// Comma-separated list: any part may match
	const parts = field.split(',');
	for (const part of parts) {
		if (matchFieldPart(part.trim(), value, min, max)) return true;
	}
	return false;
}

function matchFieldPart(part: string, value: number, min: number, max: number): boolean {
	// Step syntax: `base/step` where base may be `*` or a number or a range
	if (part.includes('/')) {
		const [base, stepStr] = part.split('/', 2) as [string, string];
		const step = parseInt(stepStr, 10);
		if (isNaN(step) || step <= 0) return false;

		let start = min;
		let end = max;
		if (base === '*') {
			start = min;
			end = max;
		} else if (base.includes('-')) {
			const [lo, hi] = base.split('-', 2) as [string, string];
			start = parseInt(lo, 10);
			end = parseInt(hi, 10);
			if (isNaN(start) || isNaN(end)) return false;
		} else {
			start = parseInt(base, 10);
			if (isNaN(start)) return false;
			end = max;
		}

		for (let v = start; v <= end; v += step) {
			if (v === value) return true;
		}
		return false;
	}

	// Wildcard
	if (part === '*') return true;

	// Range: `N-M`
	if (part.includes('-')) {
		const [lo, hi] = part.split('-', 2) as [string, string];
		const lo_n = parseInt(lo, 10);
		const hi_n = parseInt(hi, 10);
		if (isNaN(lo_n) || isNaN(hi_n)) return false;
		return value >= lo_n && value <= hi_n;
	}

	// Exact match
	const n = parseInt(part, 10);
	if (isNaN(n)) return false;
	return value === n;
}

/**
 * Test whether a 5-field cron expression matches the given Date.
 *
 * Field order: `minute hour day-of-month month day-of-week`
 * Month: 1–12. Day-of-week: 0–6 (Sunday=0).
 *
 * Returns false (with console.warn) if the expression is not exactly 5 fields.
 */
export function matchCron(expr: string, now: Date): boolean {
	if (typeof expr !== 'string') {
		console.warn(`[synapse] matchCron: expected string expression, got ${typeof expr}`);
		return false;
	}
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		console.warn(`[synapse] matchCron: expected 5 fields, got ${fields.length} in "${expr}"`);
		return false;
	}

	const [minuteF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];

	const minute = now.getMinutes();        // 0–59
	const hour = now.getHours();            // 0–23
	const dom = now.getDate();              // 1–31
	const month = now.getMonth() + 1;      // 1–12
	const dow = now.getDay();              // 0–6 (Sunday=0)

	return (
		matchField(minuteF, minute, 0, 59) &&
		matchField(hourF, hour, 0, 23) &&
		matchField(domF, dom, 1, 31) &&
		matchField(monthF, month, 1, 12) &&
		matchField(dowF, dow, 0, 6)
	);
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
			if (this.plugin.triggerScheduler) {
				void this.plugin.triggerScheduler.loadTriggers();
			}
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

			// Match found — fire the executor (fire-and-forget; errors caught inside)
			void executeTrigger(this.plugin, trigger, filePath);
		}
	}
}

// ---------------------------------------------------------------------------
// TriggerScheduler
// ---------------------------------------------------------------------------

/**
 * Evaluates scheduled (cron-based) triggers on a 60-second tick.
 *
 * - Uses `plugin.registerInterval()` for clean unload — no manual stop() needed.
 * - Deduplicates within the same minute via `plugin.settings.triggerLastFired`
 *   (persisted across plugin reloads).
 */
export class TriggerScheduler {
	private plugin: SynapsePlugin;
	private triggers: TriggerConfig[] = [];
	private started = false;

	constructor(plugin: SynapsePlugin) {
		this.plugin = plugin;
	}

	/**
	 * Load scheduled triggers and register the 60-second tick interval.
	 * The interval is registered via Obsidian's `registerInterval()` so it is
	 * automatically cleared on plugin unload.
	 */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		await this.loadTriggers();

		// Run immediate tick to handle the current minute on startup/reload
		this.tick();

		this.plugin.registerInterval(window.setInterval(() => this.tick(), 60_000));

		console.log(`[synapse] TriggerScheduler started — ${this.triggers.length} scheduled trigger(s) loaded`);
	}

	/** Called every 60 seconds to evaluate scheduled triggers. */
	private tick(): void {
		const now = new Date();
		let didFire = false;

		for (const trigger of this.triggers) {
			// Only enabled triggers (enabled defaults to true when omitted)
			if (trigger.enabled === false) continue;

			// Must have a schedule
			if (!trigger.schedule) continue;

			// Check cron match
			if (!matchCron(trigger.schedule, now)) continue;

			// Dedup: skip if already fired in this same minute
			const lastFired = this.plugin.settings.triggerLastFired[trigger.name];
			if (lastFired !== undefined) {
				if (Math.floor(lastFired / 60_000) === Math.floor(now.getTime() / 60_000)) {
					continue;
				}
			}

			// Fire! Stamp lastFired synchronously (before the async execution
			// completes) to prevent double-dispatch across overlapping ticks,
			// e.g. the immediate startup tick racing the first interval tick.
			// executeTrigger() also stamps it again on completion.
			this.plugin.settings.triggerLastFired[trigger.name] = now.getTime();
			didFire = true;
			this.fire(trigger);
		}

		if (didFire) {
			void this.plugin.saveSettings();
		}
	}

	/**
	 * Fire a matched scheduled trigger.
	 *
	 * If `trigger.path` is set, resolve it to matching vault files and execute
	 * the trigger once per file. If absent, there is no target file — execute
	 * once with no file, forcing report-only output regardless of the
	 * configured write mode (there's nothing to write back to).
	 */
	private fire(trigger: TriggerConfig): void {
		if (trigger.path) {
			const files = resolveGlobFiles(this.plugin.app, trigger.path);
			if (files.length === 0) {
				console.warn(`[synapse] Scheduled trigger "${trigger.name}": no files matched path "${trigger.path}"`);
				return;
			}
			for (const filePath of files) {
				void executeTrigger(this.plugin, trigger, filePath);
			}
			return;
		}

		// No path scoping — file-less execution. Force report-only since
		// there's no target file to write to.
		const filelessTrigger = trigger.write !== false ? {...trigger, write: false as const} : trigger;
		void executeTrigger(this.plugin, filelessTrigger, '');
	}

	/** Load scheduled triggers from `_synapse/triggers/`, keeping only those with a `schedule`. */
	async loadTriggers(): Promise<void> {
		try {
			const folder = normalizePath(`${SYNAPSE_FOLDER}/triggers`);
			const all = await scanTriggers(this.plugin.app, folder);
			this.triggers = all.filter(t => t.schedule !== undefined);
		} catch (e) {
			console.error('[synapse] TriggerScheduler: failed to load triggers:', e);
			this.triggers = [];
		}
	}
}
