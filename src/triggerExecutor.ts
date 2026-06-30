/**
 * Trigger executor — runs matched triggers against the configured model,
 * applies write modes, and records output.
 *
 * Called by TriggerWatcher (event triggers) and the cron runner (scheduled
 * triggers, issue #50).
 */

import {App, TFile, normalizePath} from 'obsidian';
import type SynapsePlugin from './main';
import type {TriggerConfig} from './types';
import {SYNAPSE_FOLDER} from './settings';
import {parseFrontmatter, modifyArtifact} from './configWriter';
import {executeLocalProviderQuery} from './providerModels';

// ---------------------------------------------------------------------------
// Template substitution
// ---------------------------------------------------------------------------

/**
 * Replace template variables in the trigger body before execution.
 *
 * Supported variables:
 * - `{{file}}` — vault-relative path of the triggering file
 * - `{{files}}` — same (for future scheduled triggers with multiple files)
 */
function substituteTemplates(body: string, filePath: string): string {
	return body
		.replace(/\{\{file\}\}/g, filePath)
		.replace(/\{\{files\}\}/g, filePath);
}

// ---------------------------------------------------------------------------
// Date helper
// ---------------------------------------------------------------------------

/** Return today's date as `YYYY-MM-DD`. */
function todayString(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Reports folder
// ---------------------------------------------------------------------------

const REPORTS_FOLDER = `${SYNAPSE_FOLDER}/reports`;

/**
 * Ensure `_synapse/reports/` exists in the vault, creating it if absent.
 */
async function ensureReportsFolder(app: App): Promise<void> {
	const folder = normalizePath(REPORTS_FOLDER);
	const exists = await app.vault.adapter.exists(folder);
	if (!exists) {
		await app.vault.createFolder(folder);
	}
}

/**
 * Append a result block to the daily report file for this trigger.
 *
 * Report path: `_synapse/reports/<trigger-name>-YYYY-MM-DD.md`
 *
 * If the file does not yet exist for today it is created with the
 * `# <name> — YYYY-MM-DD` heading. If it already exists the result
 * is appended separated by a blank line.
 *
 * Uses vault.read() + vault.modify() (not adapter.read/write) so the
 * Obsidian cache stays consistent and concurrent appends go through
 * Obsidian's internal file queue.
 */
async function appendToReport(
	app: App,
	triggerName: string,
	result: string,
	isError = false,
): Promise<void> {
	await ensureReportsFolder(app);

	const today = todayString();
	const fileName = normalizePath(`${REPORTS_FOLDER}/${triggerName}-${today}.md`);

	const heading = `# ${triggerName} — ${today}`;
	const block = isError ? `## Error\n\n${result}` : result;

	const exists = await app.vault.adapter.exists(fileName);
	if (!exists) {
		await app.vault.create(fileName, `${heading}\n\n${block}\n`);
	} else {
		// FIX (BLOCKING 2): use vault.read() + vault.modify() instead of
		// adapter.read/write to go through Obsidian's cache and avoid
		// concurrent-write clobbering.
		const tfile = app.vault.getAbstractFileByPath(fileName) as TFile;
		const current = await app.vault.read(tfile);
		await app.vault.modify(tfile, `${current}\n${block}\n`);
	}
}

// ---------------------------------------------------------------------------
// Model execution
// ---------------------------------------------------------------------------

/**
 * Execute the prompt via the configured local provider backend.
 * Reads the triggering file's content and prepends it to the prompt
 * so the model has context about the file.
 */
async function executeWithLocalModel(
	plugin: SynapsePlugin,
	prompt: string,
	filePath: string,
): Promise<string> {
	const providerConfig = plugin.copilot?.getProviderConfig();
	if (!providerConfig) {
		throw new Error('Local provider config is not available.');
	}

	// Read file content (best-effort: skip if file doesn't exist, e.g. delete events)
	let fileContent = '';
	try {
		const file = plugin.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			fileContent = await plugin.app.vault.read(file);
		}
	} catch {
		// File may not exist (e.g. delete events) — proceed without content
	}

	const fullPrompt = fileContent
		? `File: ${filePath}\n\n${fileContent}\n\n---\n\n${prompt}`
		: prompt;

	const res = await executeLocalProviderQuery(providerConfig, {prompt: fullPrompt});
	if (!res.ok) {
		throw new Error(res.error);
	}
	return res.content ?? '';
}

/**
 * Execute the prompt via the Claude Agent SDK (AgentService.inlineChat).
 */
async function executeWithClaude(
	plugin: SynapsePlugin,
	trigger: TriggerConfig,
	prompt: string,
): Promise<string> {
	if (!plugin.copilot) {
		throw new Error('AgentService is not initialized.');
	}

	const basePath = (plugin.app.vault.adapter as unknown as {basePath: string}).basePath;
	const normalizedBase = basePath.replace(/\\/g, '/');
	const pluginsPath = `${normalizedBase}/_synapse/`;

	const result = await plugin.copilot.inlineChat({
		prompt,
		model: trigger.model,
		agent: trigger.agent,
		systemMessage: undefined, // triggers use body-as-prompt; no separate system message
		cwd: basePath,
		plugins: [{type: 'local', path: pluginsPath}],
		maxTurns: 10,
		permissionMode: 'default',
	});

	return result.content ?? '';
}

// ---------------------------------------------------------------------------
// Write modes
// ---------------------------------------------------------------------------

/**
 * Apply the trigger's write mode to the model response.
 *
 * - `false` (default): append to `_synapse/reports/<name>-YYYY-MM-DD.md`
 * - `true`: replace the triggering file's entire content
 * - `'frontmatter'`: merge response (parsed as YAML) into file frontmatter
 */
async function applyWriteMode(
	plugin: SynapsePlugin,
	trigger: TriggerConfig,
	filePath: string,
	result: string,
): Promise<void> {
	const app = plugin.app;

	if (trigger.write === true) {
		// FIX (BLOCKING 1): guard against empty model response to avoid wiping the file.
		if (!result) {
			console.warn(`[synapse] Trigger "${trigger.name}": model returned empty content, skipping write-back`);
			await appendToReport(app, trigger.name, '(empty response — write skipped)');
			return;
		}
		// Full write: replace file content
		const file = app.vault.getAbstractFileByPath(normalizePath(filePath));
		if (file instanceof TFile) {
			await app.vault.modify(file, result);
		} else {
			// File doesn't exist (e.g. it was deleted) — fall back to report
			console.warn(`[synapse] Trigger "${trigger.name}": file not found for write-back, appending to report instead`);
			await appendToReport(app, trigger.name, result);
		}
		return;
	}

	if (trigger.write === 'frontmatter') {
		// FIX (BLOCKING 3 + 4): parse response via parseFrontmatter (fence the response
		// so lists and scalars are handled correctly) and write back via modifyArtifact
		// (which uses serializeFmField to quote values containing colons).
		const file = app.vault.getAbstractFileByPath(normalizePath(filePath));
		if (!(file instanceof TFile)) {
			console.warn(`[synapse] Trigger "${trigger.name}": file not found for frontmatter merge, appending to report instead`);
			await appendToReport(app, trigger.name, result);
			return;
		}

		// Wrap the model's response in a frontmatter fence so parseFrontmatter
		// correctly handles scalars, quoted strings, and list values.
		const {meta: newMeta} = parseFrontmatter(`---\n${result}\n---\n`);

		// modifyArtifact merges newMeta into existing frontmatter and serializes
		// values via serializeFmField (quotes values containing colons).
		await modifyArtifact(app, normalizePath(filePath), newMeta as Record<string, string | string[] | boolean | undefined>);
		return;
	}

	// Default (write === false or undefined): append to report
	await appendToReport(app, trigger.name, result);
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Execute a matched trigger.
 *
 * Orchestrates template substitution, model routing, write-mode application,
 * and records the `triggerLastFired` timestamp.
 *
 * Errors are caught internally, logged to console, and appended to the
 * report file so failures are visible in the vault.
 */
export async function executeTrigger(
	plugin: SynapsePlugin,
	trigger: TriggerConfig,
	filePath: string,
): Promise<void> {
	const promptBody = substituteTemplates(trigger.body, filePath);

	try {
		let result: string;

		const useLocalModel =
			trigger.model !== undefined &&
			trigger.model !== '' &&
			plugin.copilot?.isLocalModel(trigger.model) === true;

		if (useLocalModel) {
			result = await executeWithLocalModel(plugin, promptBody, filePath);
		} else {
			result = await executeWithClaude(plugin, trigger, promptBody);
		}

		await applyWriteMode(plugin, trigger, filePath, result);

		console.log(`[synapse] Trigger "${trigger.name}" executed successfully for ${filePath}`);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(`[synapse] Trigger "${trigger.name}" execution failed:`, e);

		// Append error to report so it's visible in the vault
		try {
			await appendToReport(plugin.app, trigger.name, msg, true);
		} catch (reportErr) {
			console.error('[synapse] Failed to write error report:', reportErr);
		}
	} finally {
		// Record last-fired timestamp regardless of success/failure
		plugin.settings.triggerLastFired[trigger.name] = Date.now();
		await plugin.saveSettings();
	}
}
