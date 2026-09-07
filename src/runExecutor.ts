/**
 * Run pipeline for "run a prompt against a file, then persist the result":
 * substitute template variables, route Claude vs. a local model, run, apply
 * a write mode, append a report entry. `batchLoopExecutor.ts` is its one
 * caller and is a thin one — it supplies what's caller-specific: which
 * file(s) to run over, where the prompt body comes from, how a report block
 * is formatted, and budget/cancellation/progress orchestration across many
 * items. Everything else lives here.
 *
 * This module originally also served the trigger executor
 * (`triggerExecutor.ts`, extracted alongside the batch loop executor in
 * issue #154). Triggers were removed in issue #188; issue #189 then
 * collapsed the trigger-shaped generality this pipeline carried while it had
 * two callers (a `surface` union, a per-item tool-approval override, a
 * `{{files}}` template alias — see `.docs/specs/run-executor.md`'s "Current
 * status" for the full history).
 *
 * `runItem()` deliberately does not catch execution errors: `batchLoopExecutor.ts`
 * must distinguish a genuine per-file failure from a mid-flight cancellation
 * (`handle.stop()` aborting the in-flight query), so the error is left to
 * propagate and the caller decides.
 *
 * Model: `src/budget.ts` (#74) and `src/vaultPaths.ts` (#153) — small,
 * focused extractions of exactly the logic that was duplicated, not a new
 * abstraction layer on top of it.
 *
 * Unattended tool-approval policy (issue #151): this is also the place that maps
 * `settings.toolApproval` to what the Claude branch (`executeWithClaude()`) hands the SDK. See
 * `resolveToolApprovalPolicy()` and the "Tool approval policy" section of
 * `.docs/specs/run-executor.md`.
 */

import {App, TFile, normalizePath} from 'obsidian';
import type SynapsePlugin from './main';
import type {SDKMessage, PermissionHandler, PermissionResult} from './agentService';
import {getVaultBasePath, getSynapsePluginConfig, REPORTS_FOLDER} from './vaultPaths';
import {parseFrontmatter, modifyArtifact, ensureFolder} from './configWriter';
import {executeLocalProviderQuery} from './providerModels';
import {vaultTools} from './vaultTools';
import {McpBridgeSession} from './mcpBridge';
import {lockManager, LockAcquisitionError} from './lockManager';

// ---------------------------------------------------------------------------
// Template substitution
// ---------------------------------------------------------------------------

/**
 * Replace `{{file}}` in a prompt/instruction body with the vault-relative
 * path of the file this run concerns.
 */
function substituteTemplates(body: string, filePath: string): string {
	return body.replace(/\{\{file\}\}/g, filePath);
}

// ---------------------------------------------------------------------------
// Report append (the "Lock + append report" duplication — issue #154)
// ---------------------------------------------------------------------------

/** Identifies a report file and its first-write heading for `appendReportBlock()`. */
export interface ReportTarget {
	/** Full vault-relative path to the report file, e.g. `_synapse/reports/<name>-YYYY-MM-DD.md`. */
	path: string;
	/** Heading written once, the first time the report file is created for the day. */
	heading: string;
}

/**
 * Create-or-append `block` to a report file, creating the file (with
 * `target.heading`) if this is the first entry written today, or appending
 * it below the existing content (separated by a blank line) otherwise.
 *
 * Uses `vault.read()` + `vault.modify()` (not `adapter.read`/`write`) so the
 * Obsidian cache stays consistent and concurrent appends go through
 * Obsidian's internal file queue.
 *
 * The whole read-modify-write is wrapped in `lockManager.withLock` so a
 * report append can't interleave with another plugin-initiated write to the
 * same report file (e.g. two concurrent batch loops). Does not catch
 * `LockAcquisitionError` — `batchLoopExecutor.ts` lets it propagate to the
 * per-file loop body, which already has to catch and report per-file
 * failures.
 */
export async function appendReportBlock(app: App, target: ReportTarget, block: string): Promise<void> {
	await lockManager.withLock(target.path, async () => {
		await ensureFolder(app, REPORTS_FOLDER);

		const exists = await app.vault.adapter.exists(target.path);
		if (!exists) {
			await app.vault.create(target.path, `${target.heading}\n\n${block}\n`);
		} else {
			const tfile = app.vault.getAbstractFileByPath(target.path);
			if (!(tfile instanceof TFile)) {
				throw new Error(`[synapse] Report path is not a file: ${target.path}`);
			}
			const current = await app.vault.read(tfile);
			await app.vault.modify(tfile, `${current}\n${block}\n`);
		}
	});
}

// ---------------------------------------------------------------------------
// Tool approval policy (issue #151)
// ---------------------------------------------------------------------------

/**
 * Resolved unattended tool-approval decision for one run: `'allow'` maps to
 * `bypassPermissions` (the model's tool calls proceed without asking);
 * `'ask'` maps to `permissionMode: 'default'` plus a `canUseTool` that always
 * denies — there is no human in an unattended run to ask, so "ask" can only
 * mean "deny" (see `.docs/specs/run-executor.md`).
 */
type ToolApprovalPolicy = 'allow' | 'ask';

/** Resolve the effective policy for one run from the global `settings.toolApproval` setting. */
function resolveToolApprovalPolicy(plugin: SynapsePlugin): ToolApprovalPolicy {
	return plugin.settings.toolApproval === 'allow' ? 'allow' : 'ask';
}

/** One tool call denied by the `'ask'` policy's `canUseTool`, recorded for the run's report. */
interface ToolRefusal {
	toolName: string;
}

/**
 * Build the report block for a run whose `'ask'`-policy `canUseTool` denied one or more tool
 * calls — this is what makes AC "silence is no longer a possible outcome" true: a refused tool
 * call always lands in the report file, not just a console warning nobody sees.
 */
function formatToolRefusalsReportBlock(refusals: ToolRefusal[]): string {
	const count = refusals.length;
	const items = refusals.map(r => `- \`${r.toolName}\``).join('\n');
	return [
		`**Tool approval:** ${count} tool call${count === 1 ? '' : 's'} denied — the Tools approval setting is "Ask", and unattended runs have no one to approve a request.`,
		items,
		`Set Settings → Synapse → Tools → Tools approval to "Allow (auto-approve)" to run unattended tool calls without asking.`,
	].join('\n\n');
}

/**
 * `CanUseTool` for the `'ask'` policy: denies every tool call it's invoked for (the SDK only
 * invokes it for approval-requiring tools — read-only tools like `Read`/`Glob` pass without a
 * callback even under `permissionMode: 'default'`) and records the denial into `refusals` so the
 * caller can report it. Mutates `refusals` in place rather than returning a value, since
 * `CanUseTool` is called by the SDK an arbitrary number of times over the course of one query.
 */
function makeDenyingCanUseTool(refusals: ToolRefusal[]): PermissionHandler {
	return async (toolName) => {
		refusals.push({toolName});
		// AskUserQuestion (issue #182) gets its own message here too — the generic "tools
		// approval is ask" wording would be misleading since this path denies unconditionally
		// (`resolveToolApprovalPolicy()`'s 'ask' branch), regardless of the tool-approval setting,
		// because a batch/trigger run has no attended UI to answer it.
		if (toolName === 'AskUserQuestion') {
			const result: PermissionResult = {
				behavior: 'deny',
				message: 'Synapse: no one is available to answer AskUserQuestion in this unattended run.',
			};
			return result;
		}
		const result: PermissionResult = {
			behavior: 'deny',
			message: 'Synapse: unattended runs deny tool calls while tools approval is "ask" — there is no one to ask. See this run\'s report for how to allow it.',
		};
		return result;
	};
}

// ---------------------------------------------------------------------------
// Model execution — route Claude vs. local model
// ---------------------------------------------------------------------------

/**
 * Execute the prompt via the configured local provider backend.
 * Reads the target file's content and prepends it to the prompt
 * so the model has context about the file.
 *
 * No current caller passes a `model`, so `runItem()` never selects this
 * branch today (local-model routing for batch loops was out of scope for
 * #73 and remains so; see `.docs/specs/run-executor.md`).
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
	const vaultBasePath = getVaultBasePath(plugin.app);
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

/** Result of routing+running one item's prompt: the model's text plus any tool denials to report. */
interface RunResult {
	content: string;
	refusals: ToolRefusal[];
}

/**
 * Execute the prompt via the Claude Agent SDK (`AgentService.inlineChat`).
 *
 * `agent` has no current caller; `abortController`/`onEvent` are used by
 * `batchLoopExecutor.ts` for cancellation and usage accumulation. Unused
 * options are harmless no-ops here.
 *
 * `policy` (issue #151) decides what the run is handed: `'allow'` maps to
 * `bypassPermissions` (+ `allowDangerouslySkipPermissions`, matching the
 * `toolApproval === 'allow'` pattern already used by `editorMenu.ts`/
 * `editModal.ts`/`searchPanel.ts`); `'ask'` keeps `permissionMode: 'default'`
 * but adds a `canUseTool` that denies every approval-requiring call and
 * records it into `refusals`, so a refusal is never silent.
 */
async function executeWithClaude(
	plugin: SynapsePlugin,
	prompt: string,
	policy: ToolApprovalPolicy,
	options: {model?: string; agent?: string; abortController?: AbortController; onEvent?: (msg: SDKMessage) => void} = {},
): Promise<RunResult> {
	if (!plugin.agentService) {
		throw new Error('AgentService is not initialized.');
	}

	const basePath = getVaultBasePath(plugin.app);
	const refusals: ToolRefusal[] = [];
	const permissionOptions = policy === 'allow'
		? {permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true}
		: {permissionMode: 'default' as const, canUseTool: makeDenyingCanUseTool(refusals)};

	const result = await plugin.agentService.inlineChat({
		prompt,
		app: plugin.app,
		model: options.model,
		agent: options.agent,
		// Both callers use body/instruction-as-prompt; the Claude Code preset
		// supplies the default tool-usage system prompt so the run can read the
		// affected file(s).
		systemPrompt: {type: 'preset', preset: 'claude_code'},
		cwd: basePath,
		plugins: getSynapsePluginConfig(plugin.app),
		maxTurns: 10,
		...permissionOptions,
		abortController: options.abortController,
		onEvent: options.onEvent,
	});

	return {content: result.content ?? '', refusals};
}

/**
 * Route to a local model if `model` names one known to the running
 * `AgentService`, otherwise route to Claude. Mirrors the routing decision
 * `AgentService.inlineChat()` itself makes for chat-view queries.
 *
 * `policy` only affects the Claude branch — local-model routing's tool-
 * approval gap (issue #142's follow-up, referenced by #151) is deliberately
 * out of scope here; see the module doc comment.
 */
async function routeAndRun(
	plugin: SynapsePlugin,
	prompt: string,
	filePath: string,
	policy: ToolApprovalPolicy,
	options: {model?: string; agent?: string; abortController?: AbortController; onEvent?: (msg: SDKMessage) => void} = {},
): Promise<RunResult> {
	const useLocalModel =
		options.model !== undefined &&
		options.model !== '' &&
		plugin.agentService?.isLocalModel(options.model) === true;

	if (useLocalModel) {
		const content = await executeWithLocalModel(plugin, prompt, filePath, options.model);
		return {content, refusals: []};
	}
	return executeWithClaude(plugin, prompt, policy, options);
}

// ---------------------------------------------------------------------------
// Write modes
// ---------------------------------------------------------------------------

/**
 * How to persist a run's result. `false`/`undefined` (default): append to
 * the report via `appendReport`. `true`: replace the target file's entire
 * content. `'frontmatter'`: merge the response (parsed as YAML) into the
 * target file's frontmatter.
 *
 * No current caller sets anything but the default: `batchLoopExecutor.ts`
 * always passes `undefined` (it has no equivalent config field), so it
 * always takes the "append to report" branch. See `.docs/specs/run-executor.md`.
 */
type WriteMode = boolean | 'frontmatter' | undefined;

interface ApplyWriteModeOptions {
	app: App;
	/** Vault-relative path of the file to write back to (write: true / 'frontmatter'). */
	filePath: string;
	write: WriteMode;
	/** The model's result to persist. */
	result: string;
	/** Identity used in `console.warn` messages, e.g. `Batch loop file "path"`. */
	logLabel: string;
	/** Appends `result` (or a write-mode fallback message) to the caller's report. */
	appendReport: (result: string, isError?: boolean) => Promise<void>;
}

/**
 * Apply a write mode to a run's result.
 *
 * - `false`/`undefined`: append to the report via `appendReport`.
 * - `true`: replace the target file's entire content. Guards against an
 *   empty model response (would otherwise wipe the file), a missing target
 *   file, and a write-back lock timeout — each falls back to `appendReport`.
 * - `'frontmatter'`: merge the response (parsed as YAML, via
 *   `parseFrontmatter`) into the target file's frontmatter (via
 *   `modifyArtifact`, which quotes values containing colons). Falls back to
 *   `appendReport` on a missing file or a lock timeout.
 */
async function applyWriteMode(options: ApplyWriteModeOptions): Promise<void> {
	const {app, filePath, write, result, logLabel, appendReport} = options;

	if (write === true) {
		if (!result) {
			console.warn(`[synapse] ${logLabel}: model returned empty content, skipping write-back`);
			await appendReport('(empty response — write skipped)');
			return;
		}
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
				console.warn(`[synapse] ${logLabel}: could not acquire lock for write-back, appending to report instead:`, e.message);
				await appendReport(result);
				return;
			}
			throw e;
		}
		if (!fileFound) {
			// File doesn't exist (e.g. it was deleted) — fall back to report
			console.warn(`[synapse] ${logLabel}: file not found for write-back, appending to report instead`);
			await appendReport(result);
		}
		return;
	}

	if (write === 'frontmatter') {
		const file = app.vault.getAbstractFileByPath(normalizePath(filePath));
		if (!(file instanceof TFile)) {
			console.warn(`[synapse] ${logLabel}: file not found for frontmatter merge, appending to report instead`);
			await appendReport(result);
			return;
		}

		// Wrap the model's response in a frontmatter fence so parseFrontmatter
		// correctly handles scalars, quoted strings, and list values.
		const {meta: newMeta} = parseFrontmatter(`---\n${result}\n---\n`);

		// modifyArtifact merges newMeta into existing frontmatter and serializes
		// values via serializeFmField (quotes values containing colons). It
		// acquires the lock on `filePath` internally; degrade gracefully here
		// if that acquisition times out rather than throwing out of runItem().
		try {
			await modifyArtifact(app, normalizePath(filePath), newMeta);
		} catch (e) {
			if (e instanceof LockAcquisitionError) {
				console.warn(`[synapse] ${logLabel}: could not acquire lock for frontmatter merge, appending to report instead:`, e.message);
				await appendReport(result);
				return;
			}
			throw e;
		}
		return;
	}

	// Default (write === false or undefined): append to report
	await appendReport(result);
}

// ---------------------------------------------------------------------------
// Top-level pipeline
// ---------------------------------------------------------------------------

export interface RunItemOptions {
	plugin: SynapsePlugin;
	/** Vault-relative path this item concerns — substituted for `{{file}}` and used as the write-back target. */
	filePath: string;
	/** Prompt/instruction body, before template substitution. */
	body: string;
	/** Model alias or local-model id. `undefined` always routes to Claude (no current caller sets this). */
	model?: string;
	/** Claude agent name. No current caller sets this. */
	agent?: string;
	write?: WriteMode;
	/** Identity used in `console.warn` messages, e.g. `Batch loop file "path"`. */
	logLabel: string;
	appendReport: (result: string, isError?: boolean) => Promise<void>;
	/** Forwarded to `inlineChat()` for in-flight cancellation. */
	abortController?: AbortController;
	/** Forwarded to `inlineChat()` to accumulate usage/cost. */
	onEvent?: (msg: SDKMessage) => void;
}

/**
 * Run one work item through the full pipeline: substitute template
 * variables, route to Claude or a local model, execute, then apply the write
 * mode (persisting the result to the target file, its frontmatter, or the
 * report).
 *
 * Tool-approval policy (issue #151): resolved once per run via
 * `resolveToolApprovalPolicy()` and handed to the Claude branch. If the resolved policy is
 * `'ask'` and one or more tool calls were denied, a report block recording those denials is
 * always appended — regardless of `write` mode, so a refusal is visible even when the run's
 * main result went to the target file/frontmatter rather than the report.
 *
 * Does not catch execution errors — see the module doc comment for why.
 */
export async function runItem(options: RunItemOptions): Promise<void> {
	const prompt = substituteTemplates(options.body, options.filePath);
	const policy = resolveToolApprovalPolicy(options.plugin);

	const {content: result, refusals} = await routeAndRun(options.plugin, prompt, options.filePath, policy, {
		model: options.model,
		agent: options.agent,
		abortController: options.abortController,
		onEvent: options.onEvent,
	});

	await applyWriteMode({
		app: options.plugin.app,
		filePath: options.filePath,
		write: options.write,
		result,
		logLabel: options.logLabel,
		appendReport: options.appendReport,
	});

	if (refusals.length > 0) {
		await options.appendReport(formatToolRefusalsReportBlock(refusals));
	}
}
