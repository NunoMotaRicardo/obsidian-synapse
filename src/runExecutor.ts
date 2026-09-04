/**
 * Shared run pipeline for the two "run a prompt against a file, then persist
 * the result" surfaces: the trigger executor (`triggerExecutor.ts`) and the
 * batch loop executor (`batchLoopExecutor.ts`).
 *
 * Both independently implemented the same five steps — substitute template
 * variables, route Claude vs. a local model, run, apply a write mode, append
 * a report entry — before this extraction (issue #154). This module owns
 * that pipeline; `triggerExecutor.ts`/`batchLoopExecutor.ts` are thin callers
 * that supply what differs: which file(s) to run over, where the prompt body
 * comes from, and how a report block is formatted. Everything outside the
 * per-item pipeline (trigger's `triggerLastFired` stamp, batch loop's
 * budget/cancellation/progress orchestration across many items) stays in the
 * respective caller — it isn't part of what was duplicated.
 *
 * `runItem()` deliberately does not catch execution errors: the two callers
 * need different failure handling (`triggerExecutor.ts` always converts a
 * failure into a report entry; `batchLoopExecutor.ts` must first distinguish
 * a genuine per-file failure from a mid-flight cancellation), so the error is
 * left to propagate and each caller decides.
 *
 * Model: `src/budget.ts` (#74) and `src/vaultPaths.ts` (#153) — small,
 * focused extractions of exactly the logic that was duplicated, not a new
 * abstraction layer on top of it.
 *
 * Unattended tool-approval policy (issue #151): this is also the one place that maps
 * `settings.toolApproval` to what the Claude branch (`executeWithClaude()`) hands the SDK, so
 * triggers and batch loops agree on what "ask" and "allow" mean. See `resolveToolApprovalPolicy()`
 * and the "Tool approval policy" section of `.docs/specs/run-executor.md`.
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
 * Replace template variables in a prompt/instruction body before execution.
 *
 * - `{{file}}` — vault-relative path of the file this run concerns.
 * - `{{files}}` — alias for `{{file}}`, trigger-only (`aliasFiles: true`).
 *   Scheduled triggers with a `path` glob fan out to one `executeTrigger()`
 *   call per matched file (see `TriggerScheduler.fire()` in `triggers.ts`),
 *   so each execution only ever sees a single file — there is no list to
 *   substitute. Batch loops don't request this alias: their instruction
 *   already only ever documented `{{file}}` (#73), and substituting a second
 *   pattern there would be a silent behavior change for any instruction that
 *   happens to contain the literal text `{{files}}`.
 */
export function substituteTemplates(body: string, filePath: string, options: {aliasFiles?: boolean} = {}): string {
	let result = body.replace(/\{\{file\}\}/g, filePath);
	if (options.aliasFiles) {
		result = result.replace(/\{\{files\}\}/g, filePath);
	}
	return result;
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
 * same report file (another trigger firing for the same name/day, or a batch
 * loop). Does not catch `LockAcquisitionError` — that decision is caller
 * -specific: `triggerExecutor.ts` degrades gracefully (warns and drops the
 * entry) so a wedged holder can't block `executeTrigger()` forever;
 * `batchLoopExecutor.ts` lets it propagate to the per-file loop body, which
 * already has to catch and report per-file failures.
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
export type ToolApprovalPolicy = 'allow' | 'ask';

/**
 * Resolve the effective policy for one run: `overrideAllow` (a trigger's
 * `toolApproval: allow` frontmatter opt-in) wins over a global `'ask'`
 * setting; there is no override in the other direction (a trigger cannot
 * force `'ask'` when the global setting is already `'allow'`). Batch loops
 * never pass `overrideAllow` — they have no per-item config to opt in from —
 * so they always follow the global setting directly.
 */
export function resolveToolApprovalPolicy(plugin: SynapsePlugin, overrideAllow?: boolean): ToolApprovalPolicy {
	if (plugin.settings.toolApproval === 'allow' || overrideAllow) return 'allow';
	return 'ask';
}

/** One tool call denied by the `'ask'` policy's `canUseTool`, recorded for the run's report. */
export interface ToolRefusal {
	toolName: string;
}

/**
 * Build the report block for a run whose `'ask'`-policy `canUseTool` denied one or more tool
 * calls — this is what makes AC "silence is no longer a possible outcome" true: a refused tool
 * call always lands in the report file, not just a console warning nobody sees.
 *
 * `surface` tailors the escape-hatch hint: triggers can opt in per-trigger via frontmatter; batch
 * loops have no per-run config surface to opt in from, so only the global setting is mentioned.
 */
export function formatToolRefusalsReportBlock(refusals: ToolRefusal[], surface: 'trigger' | 'batch-loop'): string {
	const count = refusals.length;
	const items = refusals.map(r => `- \`${r.toolName}\``).join('\n');
	const overrideHint = surface === 'trigger'
		? 'Add `toolApproval: allow` to this trigger\'s frontmatter to allow it for just this trigger, or set '
		: 'Set ';
	return [
		`**Tool approval:** ${count} tool call${count === 1 ? '' : 's'} denied — the Tools approval setting is "Ask", and unattended runs have no one to approve a request.`,
		items,
		`${overrideHint}Settings → Synapse → Tools → Tools approval to "Allow (auto-approve)" to run unattended tool calls without asking.`,
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
 * Reads the triggering file's content and prepends it to the prompt
 * so the model has context about the file.
 *
 * Local-model routing is trigger-only (`triggerExecutor.ts`) — batch loops
 * never pass a `model`, so `runItem()` never selects this branch for them
 * (local-model routing for batch loops was out of scope for #73 and remains
 * so here; see `.docs/specs/run-executor.md`).
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
 * `agent`/`abortController`/`onEvent` are each only meaningful to one
 * caller today (`agent` — trigger-only; `abortController`/`onEvent` —
 * batch-loop-only, for cancellation and usage accumulation) but are
 * harmless no-ops for the other, so this stays a single shared call site
 * rather than two near-identical ones.
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
 * Write modes are a trigger-only concept (`TriggerConfig.write`) — batch
 * loops always pass `undefined` here (they have no equivalent config field),
 * so they always take the default "append to report" branch. See
 * `.docs/specs/run-executor.md` for the reasoning.
 */
export type WriteMode = boolean | 'frontmatter' | undefined;

export interface ApplyWriteModeOptions {
	app: App;
	/** Vault-relative path of the file to write back to (write: true / 'frontmatter'). */
	filePath: string;
	write: WriteMode;
	/** The model's result to persist. */
	result: string;
	/** Identity used in `console.warn` messages, e.g. `Trigger "name"`. */
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
export async function applyWriteMode(options: ApplyWriteModeOptions): Promise<void> {
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
	/** Vault-relative path this item concerns — substituted for `{{file}}`/`{{files}}` and used as the write-back target. */
	filePath: string;
	/** Prompt/instruction body, before template substitution. */
	body: string;
	/** Also substitute `{{files}}` as an alias for `{{file}}` (trigger-only, see `substituteTemplates()`). */
	aliasFiles?: boolean;
	/** Model alias or local-model id. `undefined` always routes to Claude (batch loops never set this). */
	model?: string;
	/** Claude agent name. Trigger-only; batch loops have no agent concept. */
	agent?: string;
	write?: WriteMode;
	/** Identity used in `console.warn` messages, e.g. `Trigger "name"`. */
	logLabel: string;
	appendReport: (result: string, isError?: boolean) => Promise<void>;
	/** Batch-loop-only: forwarded to `inlineChat()` for in-flight cancellation. */
	abortController?: AbortController;
	/** Batch-loop-only: forwarded to `inlineChat()` to accumulate usage/cost. */
	onEvent?: (msg: SDKMessage) => void;
	/**
	 * Which surface this run is for — tailors the escape-hatch hint in a tool-refusal report
	 * block (see `formatToolRefusalsReportBlock()`). Triggers can opt in per-trigger via
	 * frontmatter; batch loops can't, so only the global setting is mentioned for them.
	 */
	surface: 'trigger' | 'batch-loop';
	/**
	 * Trigger-only: this trigger's `toolApproval: allow` frontmatter opt-in (issue #151).
	 * Batch loops never set this — they always follow `settings.toolApproval` directly. See
	 * `resolveToolApprovalPolicy()`.
	 */
	toolApprovalOverrideAllow?: boolean;
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
	const prompt = substituteTemplates(options.body, options.filePath, {aliasFiles: options.aliasFiles});
	const policy = resolveToolApprovalPolicy(options.plugin, options.toolApprovalOverrideAllow);

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
		await options.appendReport(formatToolRefusalsReportBlock(refusals, options.surface));
	}
}
