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
import {vaultTools} from './vaultTools';
import {McpBridgeSession} from './mcpBridge';
import {lockManager, LockAcquisitionError} from './lockManager';

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
 *
 * The whole read-modify-write is wrapped in `lockManager.withLock` so a
 * trigger's report append can't interleave with another plugin-initiated
 * write to the same report file (another trigger firing for the same name/
 * day, or a batch loop). If the lock times out (a wedged holder), this
 * degrades gracefully — logs a warning and returns without throwing, rather
 * than blocking `executeTrigger` forever.
 */
async function appendToReport(
	app: App,
	triggerName: string,
	result: string,
	isError = false,
): Promise<void> {
	const today = todayString();
	const fileName = normalizePath(`${REPORTS_FOLDER}/${triggerName}-${today}.md`);

	const heading = `# ${triggerName} — ${today}`;
	const block = isError ? `## Error\n\n${result}` : result;

	try {
		await lockManager.withLock(fileName, async () => {
			await ensureReportsFolder(app);

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
		});
	} catch (e) {
		if (e instanceof LockAcquisitionError) {
			console.warn(`[synapse] Trigger "${triggerName}": could not acquire report lock, dropping this report entry:`, e.message);
			return;
		}
		throw e;
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
	modelId?: string,
): Promise<string> {
	const providerConfig = plugin.agentService?.getProviderConfig();
	if (!providerConfig) {
		throw new Error('Local provider config is not available.');
	}

	// Only equip the model with vault tools if it's known to support tool calling.
	// Models with no capability info (not found / undetermined) default to allowed,
	// since most OpenAI-compatible backends don't expose a capability list at all.
	const modelInfo = modelId ? plugin.agentService?.getModels().find(m => m.id === modelId) : undefined;
	const supportsTools = modelInfo?.supportsTools !== false;

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

	// Start MCP bridge session — spawn servers from _synapse/.mcp.json and collect
	// their tools to merge alongside built-in vault tools.
	const vaultBasePath = (plugin.app.vault.adapter as unknown as {basePath: string}).basePath;
	const mcpSession = new McpBridgeSession();
	let mcpTools: import('./providerModels').LocalTool[] = [];
	if (supportsTools) {
		try {
			mcpTools = await mcpSession.start(vaultBasePath);
		} catch (e) {
			console.warn('[synapse] MCP bridge start failed (continuing without MCP tools):', e);
		}
	}

	try {
		const allTools = supportsTools ? [...vaultTools, ...mcpTools] : [];
		const res = await executeLocalProviderQuery(providerConfig, {
			prompt: fullPrompt,
			...(allTools.length > 0 ? {tools: allTools, app: plugin.app} : {}),
		});
		if (!res.ok) {
			throw new Error(res.error);
		}
		const content = res.content ?? '';
		return res.truncated
			? `${content}\n\n_(Synapse: tool-calling loop reached the turn limit before the model finished.)_`
			: content;
	} finally {
		// Always shut down MCP servers after the query completes (success or error)
		await mcpSession.stop();
	}
}

/**
 * Execute the prompt via the Claude Agent SDK (AgentService.inlineChat).
 */
async function executeWithClaude(
	plugin: SynapsePlugin,
	trigger: TriggerConfig,
	prompt: string,
): Promise<string> {
	if (!plugin.agentService) {
		throw new Error('AgentService is not initialized.');
	}

	const basePath = (plugin.app.vault.adapter as unknown as {basePath: string}).basePath;
	const normalizedBase = basePath.replace(/\\/g, '/');
	const pluginsPath = `${normalizedBase}/_synapse/`;

	const result = await plugin.agentService.inlineChat({
		prompt,
		model: trigger.model,
		agent: trigger.agent,
		// Triggers use body-as-prompt; the Claude Code preset supplies the default
		// tool-usage system prompt so the trigger can read the affected files.
		systemPrompt: {type: 'preset', preset: 'claude_code'},
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
		const normalized = normalizePath(filePath);
		let fileFound = false;
		try {
			await lockManager.withLock(normalized, async () => {
				const file = app.vault.getAbstractFileByPath(normalized);
				if (!(file instanceof TFile)) {
					return;
				}
				fileFound = true;
				await app.vault.modify(file, result);
			});
		} catch (e) {
			if (e instanceof LockAcquisitionError) {
				console.warn(`[synapse] Trigger "${trigger.name}": could not acquire lock for write-back, appending to report instead:`, e.message);
				await appendToReport(app, trigger.name, result);
				return;
			}
			throw e;
		}
		if (!fileFound) {
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
		// values via serializeFmField (quotes values containing colons). It
		// acquires the lock on `filePath` internally; degrade gracefully here
		// if that acquisition times out rather than throwing out of executeTrigger.
		try {
			await modifyArtifact(app, normalizePath(filePath), newMeta as Record<string, string | string[] | boolean | undefined>);
		} catch (e) {
			if (e instanceof LockAcquisitionError) {
				console.warn(`[synapse] Trigger "${trigger.name}": could not acquire lock for frontmatter merge, appending to report instead:`, e.message);
				await appendToReport(app, trigger.name, result);
				return;
			}
			throw e;
		}
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
			plugin.agentService?.isLocalModel(trigger.model) === true;

		if (useLocalModel) {
			result = await executeWithLocalModel(plugin, promptBody, filePath, trigger.model);
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
