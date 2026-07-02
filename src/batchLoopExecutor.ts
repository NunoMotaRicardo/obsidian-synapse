/**
 * Batch loop executor — runs a single user-supplied prompt sequentially over a
 * chosen set of vault files ("batch loop"), calling the configured agent once
 * per file and recording results.
 *
 * User-initiated (command palette), plugin-orchestrated iteration — mirrors
 * `src/triggerExecutor.ts`'s model-routing and report-writing pattern. This is
 * the foundational slice (#73) of the Tier-2 batch-loops feature (#66).
 * Budget caps and true in-flight cancellation (#74) build on the extension
 * points (`onProgress`, `BatchLoopHandle`) that #73 left in place for them. A
 * richer progress UI (replacing the plain per-file `Notice`s) is tracked
 * separately (#75).
 */

import {App, Notice, TFile, TFolder, normalizePath} from 'obsidian';
import type SynapsePlugin from './main';
import type {SDKResultMessage} from './agentService';
import {SYNAPSE_FOLDER} from './settings';
import {ensureFolder} from './configWriter';
import {VaultScopeModal} from './modals/vaultScopeModal';
import {UserInputModal} from './modals/userInputModal';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of files a single batch loop run will process.
 * Configurable constant for this slice — a settings UI can expose this later
 * if needed. If the resolved scope exceeds this, the run stops before
 * starting and reports how many files were skipped.
 */
export const BATCH_LOOP_MAX_FILES = 50;

const REPORTS_FOLDER = `${SYNAPSE_FOLDER}/reports`;
const REPORT_NAME = 'batch-loop';

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * A user-configured spend cap for a single batch loop run — either a maximum
 * total token count (input + output + cache tokens, summed across every
 * `SDKResultMessage` seen) or a maximum total dollar spend (summed
 * `total_cost_usd`). `undefined` (no budget set) means unlimited, matching
 * #73's original behavior.
 */
export type BatchLoopBudget =
	| {type: 'tokens'; max: number}
	| {type: 'dollars'; max: number};

/**
 * Parse the free-text budget prompt from `launchBatchLoop()`'s launch-flow
 * modal into a `BatchLoopBudget`, or `undefined` for "no budget" (empty
 * input, or the literal `none`/`skip`).
 *
 * Accepted formats:
 * - `$5`, `$5.50`, `5 dollars`, `5 usd` → dollar budget.
 * - `500000`, `500000 tokens` → token budget (bare numbers default to tokens;
 *   must be a whole number — token usage is always integer, so a fractional
 *   value like `1.5` is almost certainly a typo and is rejected).
 * - `` (empty), `none`, `skip` → no budget (unlimited, case-insensitive).
 *
 * Returns `null` if the input doesn't parse as any of the above, so the
 * caller can re-prompt rather than silently ignoring a typo.
 */
export function parseBudgetInput(raw: string): BatchLoopBudget | undefined | null {
	const trimmed = raw.trim();
	if (trimmed === '' || /^(none|skip)$/i.test(trimmed)) {
		return undefined;
	}

	const dollarMatch = trimmed.match(/^\$?\s*([0-9]+(?:\.[0-9]+)?)\s*(usd|dollars?|\$)?$/i);
	if (dollarMatch && (trimmed.startsWith('$') || /usd|dollars?|\$/i.test(dollarMatch[2] ?? ''))) {
		const max = Number(dollarMatch[1]);
		if (!Number.isFinite(max) || max <= 0) return null;
		return {type: 'dollars', max};
	}

	const tokenMatch = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*(tokens?)?$/i);
	if (tokenMatch) {
		const max = Number(tokenMatch[1]);
		if (!Number.isInteger(max) || max <= 0) return null;
		return {type: 'tokens', max};
	}

	return null;
}

/** Sum the token fields Anthropic reports as "usage" for a result message. */
function totalTokensForResult(usage: SDKResultMessage['usage']): number {
	return (
		(usage.input_tokens ?? 0) +
		(usage.output_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0)
	);
}

/** Cumulative usage/cost tracked across a batch loop run, for budget enforcement. */
export interface BatchLoopUsage {
	totalTokens: number;
	totalCostUsd: number;
}

/** Human-readable description of a budget, for `Notice`s and report entries. */
function describeBudget(budget: BatchLoopBudget): string {
	return budget.type === 'dollars'
		? `$${budget.max.toFixed(2)}`
		: `${budget.max.toLocaleString()} tokens`;
}

/** Whether cumulative usage has met or exceeded the configured budget. */
function budgetExceeded(usage: BatchLoopUsage, budget: BatchLoopBudget): boolean {
	return budget.type === 'dollars' ? usage.totalCostUsd >= budget.max : usage.totalTokens >= budget.max;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the paths picked in `VaultScopeModal` (a mix of file and folder
 * paths, or `'/'` for the whole vault) into a flat, de-duplicated list of
 * vault-relative markdown file paths.
 *
 * Folders are expanded recursively; only `.md` files are included (matches
 * the convention used by `configWriter.ts`'s `scanAgents`/`scanTriggers`).
 */
export function resolveScopeToFiles(app: App, paths: string[]): string[] {
	const result = new Set<string>();
	const synapseBase = normalizePath(SYNAPSE_FOLDER);

	const addFolder = (folder: TFolder): void => {
		for (const child of folder.children) {
			// Exclude the _synapse/ customization folder to avoid the loop
			// processing agent/skill/report artifacts (same rationale as
			// TriggerWatcher's feedback-loop guard).
			if (child.path === synapseBase || child.path.startsWith(`${synapseBase}/`)) continue;

			if (child instanceof TFolder) {
				addFolder(child);
			} else if (child instanceof TFile && child.extension === 'md') {
				result.add(child.path);
			}
		}
	};

	for (const p of paths) {
		if (p === '/') {
			addFolder(app.vault.getRoot());
			continue;
		}
		const abs = app.vault.getAbstractFileByPath(normalizePath(p));
		if (abs instanceof TFolder) {
			addFolder(abs);
		} else if (abs instanceof TFile && abs.extension === 'md') {
			result.add(abs.path);
		}
	}

	return [...result].sort();
}

// ---------------------------------------------------------------------------
// Template substitution
// ---------------------------------------------------------------------------

/** Replace `{{file}}` in the instruction with the vault-relative file path. */
function substituteTemplate(instruction: string, filePath: string): string {
	return instruction.replace(/\{\{file\}\}/g, filePath);
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
// Report writing (mirrors triggerExecutor.ts's appendToReport)
// ---------------------------------------------------------------------------

/**
 * Create-or-append `block` to today's batch-loop report file, creating the
 * file (and its `# batch-loop — YYYY-MM-DD` heading) if this is the first
 * entry written for today. Shared by `appendToReport()` (per-file result
 * entries) and `appendRunSummary()` (early-stop run summary entries) — only
 * the block content differs between them.
 *
 * Uses vault.read()/vault.modify() (not `adapter.read`/`write`) so the
 * Obsidian cache and internal file queue stay consistent — same rationale as
 * the trigger executor's `appendToReport()`.
 */
async function appendBlockToReport(plugin: SynapsePlugin, block: string): Promise<void> {
	const app = plugin.app;
	await ensureFolder(app, REPORTS_FOLDER);

	const today = todayString();
	const reportPath = normalizePath(`${REPORTS_FOLDER}/${REPORT_NAME}-${today}.md`);
	const heading = `# ${REPORT_NAME} — ${today}`;

	const exists = await app.vault.adapter.exists(reportPath);
	if (!exists) {
		await app.vault.create(reportPath, `${heading}\n\n${block}\n`);
	} else {
		const tfile = app.vault.getAbstractFileByPath(reportPath) as TFile;
		const current = await app.vault.read(tfile);
		await app.vault.modify(tfile, `${current}\n${block}\n`);
	}
}

/**
 * Append a result block to today's batch-loop report file.
 *
 * Report path: `_synapse/reports/batch-loop-YYYY-MM-DD.md`. See
 * `appendBlockToReport()` for the shared create-or-append logic.
 */
async function appendToReport(
	plugin: SynapsePlugin,
	filePath: string,
	result: string,
	isError = false,
): Promise<void> {
	const entryHeading = `## ${filePath}`;
	const block = isError ? `${entryHeading}\n\n### Error\n\n${result}` : `${entryHeading}\n\n${result}`;
	await appendBlockToReport(plugin, block);
}

// ---------------------------------------------------------------------------
// Model execution
// ---------------------------------------------------------------------------

/**
 * Execute the instruction for a single file via AgentService.inlineChat().
 * Same routing pattern as `executeTrigger()`'s Claude path — this slice
 * always routes through Claude (local-model routing for batch loops is not
 * in scope for #73).
 *
 * `abortController` is passed straight through to `inlineChat()` (which
 * threads it into `sendAndWaitWithAbort()`), so `BatchLoopHandle.stop()` can
 * abort this specific in-flight query rather than only stopping the loop
 * between files (#74/AC-4). `onResult` is invoked with the file's
 * `SDKResultMessage`, when one arrives, so the caller can accumulate
 * usage/cost for budget enforcement (#74/AC-2).
 */
async function runOnFile(
	plugin: SynapsePlugin,
	instruction: string,
	filePath: string,
	abortController: AbortController,
	onResult?: (result: SDKResultMessage) => void,
): Promise<string> {
	if (!plugin.agentService) {
		throw new Error('AgentService is not initialized.');
	}

	const prompt = substituteTemplate(instruction, filePath);

	const basePath = (plugin.app.vault.adapter as unknown as {basePath: string}).basePath;
	const normalizedBase = basePath.replace(/\\/g, '/');
	const pluginsPath = `${normalizedBase}/_synapse/`;

	const result = await plugin.agentService.inlineChat({
		prompt,
		// Claude Code preset supplies the default tool-usage system prompt so the
		// loop can read the target file referenced by the substituted path.
		systemPrompt: {type: 'preset', preset: 'claude_code'},
		cwd: basePath,
		plugins: [{type: 'local', path: pluginsPath}],
		maxTurns: 10,
		permissionMode: 'default',
		abortController,
		onEvent: onResult ? (msg) => {
			if (msg.type === 'result') {
				onResult(msg as SDKResultMessage);
			}
		} : undefined,
	});

	return result.content ?? '';
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * Mutable handle allowing a caller (e.g. a "Stop" Notice button) to request
 * cancellation of an in-flight batch loop. The loop checks `cancelled`
 * between files and halts before starting the next one, *and* `stop()`
 * aborts the `AbortController` for whichever file is currently in flight
 * (registered by the loop via `setActiveController()`), so a click on "Stop"
 * interrupts the current query immediately rather than waiting for it to
 * finish (#74/AC-4) — reuses `AgentService`'s existing
 * `AbortController`/`sendAndWaitWithAbort` cancellation pattern rather than
 * inventing a parallel one.
 */
export class BatchLoopHandle {
	cancelled = false;
	private activeController: AbortController | null = null;

	stop(): void {
		this.cancelled = true;
		this.activeController?.abort();
	}

	/** Called by the loop before/after each file's `inlineChat()` call. */
	setActiveController(controller: AbortController | null): void {
		this.activeController = controller;
	}
}

// ---------------------------------------------------------------------------
// Per-file progress hook (extensibility point for #75's progress UI)
// ---------------------------------------------------------------------------

export interface BatchLoopProgress {
	/** 1-based index of the file currently being processed. */
	index: number;
	/** Total number of files in this run. */
	total: number;
	/** Vault-relative path of the file currently being processed. */
	filePath: string;
}

/** Why a batch loop run ended before processing every file in scope. */
export type BatchLoopStopReason = 'completed' | 'cancelled' | 'budget-exceeded' | 'scope-too-large';

export interface BatchLoopResult {
	processed: number;
	failed: number;
	skipped: number;
	cancelled: boolean;
	/** Why the run ended. `'completed'` means every file in scope was attempted. */
	reason: BatchLoopStopReason;
}

/**
 * Append a run-summary note to today's report explaining a non-`'completed'`
 * stop — how many files were processed vs. skipped and why (#74/AC-3, AC-5).
 * Appended once per run, after the last file-level entry, under a
 * `### Run summary` heading so it reads distinctly from per-file results.
 */
async function appendRunSummary(
	plugin: SynapsePlugin,
	reason: BatchLoopStopReason,
	processed: number,
	failed: number,
	skipped: number,
	total: number,
	budget?: BatchLoopBudget,
	usage?: BatchLoopUsage,
): Promise<void> {
	const reasonText = reason === 'cancelled'
		? 'stopped by user (cancelled)'
		: reason === 'budget-exceeded'
			? `stopped — budget exhausted${budget ? ` (limit: ${describeBudget(budget)})` : ''}`
			: 'scope exceeded the file-count limit before the run started';

	const usageLine = usage
		? `\n- Cumulative usage: ${usage.totalTokens.toLocaleString()} tokens, $${usage.totalCostUsd.toFixed(4)}`
		: '';

	const block = `### Run summary\n\n- Status: ${reasonText}\n- Files processed: ${processed}\n- Files failed: ${failed}\n- Files skipped/remaining: ${skipped}\n- Total files in scope: ${total}${usageLine}`;

	await appendBlockToReport(plugin, block);
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Run a batch loop: sequentially execute `instruction` (with `{{file}}`
 * substitution) against each file in `filePaths`, appending results to
 * `_synapse/reports/batch-loop-YYYY-MM-DD.md`.
 *
 * - Enforces `BATCH_LOOP_MAX_FILES`: if `filePaths.length` exceeds the cap,
 *   the run does not start; it reports the overage via `Notice` and the
 *   returned `skipped` count instead.
 * - Enforces an optional `budget` (max tokens or max dollar spend): cumulative
 *   usage/cost is tracked from each file's `SDKResultMessage` and checked
 *   *after* a file's result comes back, before the next file starts — a
 *   budget check never cuts a file off mid-flight (#74/AC-2). `undefined`
 *   means unlimited (matches #73's original behavior).
 * - Cancellation via `handle.stop()` is checked between files *and* aborts
 *   whichever file is currently in flight, via the `AbortController` passed
 *   to `runOnFile()`/`inlineChat()` (#74/AC-4).
 * - When the run stops early (budget exhaustion or cancellation), a run
 *   summary is appended to the report recording files processed vs. skipped
 *   and why (#74/AC-3, AC-5), in addition to the `Notice`.
 * - Progress is reported via `Notice` after each file and forwarded to the
 *   optional `onProgress` hook for callers that want richer UI (#75).
 * - Errors for an individual file are caught, logged, and appended to the
 *   report under an `### Error` heading — one failing file does not abort
 *   the rest of the run.
 */
export async function runBatchLoop(
	plugin: SynapsePlugin,
	filePaths: string[],
	instruction: string,
	handle: BatchLoopHandle,
	onProgress?: (progress: BatchLoopProgress) => void,
	budget?: BatchLoopBudget,
): Promise<BatchLoopResult> {
	if (filePaths.length > BATCH_LOOP_MAX_FILES) {
		const skipped = filePaths.length - BATCH_LOOP_MAX_FILES;
		new Notice(
			`Synapse: batch loop scope has ${filePaths.length} files, exceeding the limit of ` +
			`${BATCH_LOOP_MAX_FILES}. Narrow the selection and try again. (${skipped} file${skipped === 1 ? '' : 's'} skipped.)`,
			10000,
		);
		return {processed: 0, failed: 0, skipped, cancelled: false, reason: 'scope-too-large'};
	}

	const total = filePaths.length;
	let processed = 0;
	let failed = 0;
	const usage: BatchLoopUsage = {totalTokens: 0, totalCostUsd: 0};

	for (let i = 0; i < total; i++) {
		if (handle.cancelled) {
			const attempted = processed + failed;
			const skipped = total - attempted;
			new Notice(`Synapse: batch loop stopped by user after ${attempted}/${total} file(s).`);
			await appendRunSummary(plugin, 'cancelled', processed, failed, skipped, total, budget, usage);
			return {processed, failed, skipped, cancelled: true, reason: 'cancelled'};
		}

		if (budget && budgetExceeded(usage, budget)) {
			const attempted = processed + failed;
			const skipped = total - attempted;
			new Notice(
				`Synapse: batch loop stopped — budget of ${describeBudget(budget)} exhausted after ` +
				`${attempted}/${total} file(s).`,
				10000,
			);
			await appendRunSummary(plugin, 'budget-exceeded', processed, failed, skipped, total, budget, usage);
			return {processed, failed, skipped, cancelled: false, reason: 'budget-exceeded'};
		}

		const filePath = filePaths[i]!;
		const index = i + 1;

		new Notice(`Synapse: processing ${index}/${total}: ${filePath}`);
		onProgress?.({index, total, filePath});

		const fileController = new AbortController();
		handle.setActiveController(fileController);

		try {
			const result = await runOnFile(plugin, instruction, filePath, fileController, (resultMsg) => {
				usage.totalTokens += totalTokensForResult(resultMsg.usage);
				usage.totalCostUsd += resultMsg.total_cost_usd;
			});
			await appendToReport(plugin, filePath, result);
			processed++;
			console.log(`[synapse] Batch loop processed ${filePath} (${index}/${total})`);
		} catch (e) {
			if (handle.cancelled) {
				// Aborted by handle.stop() mid-file — treat as cancellation, not a
				// per-file failure; the top-of-loop check on the next iteration
				// (which never runs, since we return here) would otherwise double
				// count this file. Report it as not-yet-completed.
				const attempted = processed + failed;
				const skipped = total - attempted;
				new Notice(`Synapse: batch loop stopped by user while processing ${filePath} (after ${attempted}/${total} file(s)).`);
				await appendRunSummary(plugin, 'cancelled', processed, failed, skipped, total, budget, usage);
				return {processed, failed, skipped, cancelled: true, reason: 'cancelled'};
			}
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`[synapse] Batch loop failed for ${filePath}:`, e);
			failed++;
			try {
				await appendToReport(plugin, filePath, msg, true);
			} catch (reportErr) {
				console.error('[synapse] Failed to write batch loop error report:', reportErr);
			}
		} finally {
			handle.setActiveController(null);
		}
	}

	new Notice(`Synapse: batch loop finished — ${processed}/${total} file(s) processed${failed > 0 ? `, ${failed} failed` : ''}.`);
	return {processed, failed, skipped: 0, cancelled: false, reason: 'completed'};
}

// ---------------------------------------------------------------------------
// Launch flow (command palette entry point)
// ---------------------------------------------------------------------------

/**
 * Show a persistent `Notice` with a "Stop" action button that, when clicked,
 * requests cancellation via `handle.stop()`. The notice is dismissed once the
 * loop finishes (caller is responsible for hiding it).
 */
function showStopNotice(handle: BatchLoopHandle): Notice {
	const fragment = createFragment((el: DocumentFragment) => {
		el.createSpan({text: 'Synapse: batch loop running… '});
		const btn = el.createEl('button', {text: 'Stop'});
		btn.addEventListener('click', () => {
			handle.stop();
			btn.disabled = true;
			btn.setText('Stopping…');
		});
	});
	// Duration 0 keeps the notice (and its Stop button) visible until the
	// loop completes and explicitly hides it.
	return new Notice(fragment, 0);
}

/**
 * Launch a batch loop from the command palette: open `VaultScopeModal` to
 * pick target files/folders, then `UserInputModal` for the per-file
 * instruction, then run the loop with a "Stop" notice for cancellation.
 *
 * Exported separately from the command registration (in `main.ts`) so the
 * launch flow's own logic (scope resolution, empty-scope guard) stays here
 * rather than in the lifecycle-only `main.ts`.
 */
export function launchBatchLoop(plugin: SynapsePlugin): void {
	new VaultScopeModal(plugin.app, [], (paths) => {
		void (async () => {
			if (paths.length === 0) {
				new Notice('Synapse: no files or folders selected — batch loop cancelled.');
				return;
			}

			const filePaths = resolveScopeToFiles(plugin.app, paths);
			if (filePaths.length === 0) {
				new Notice('Synapse: selected scope contains no markdown files.');
				return;
			}

			const inputModal = new UserInputModal(plugin.app, {
				question: `Enter the instruction to run over ${filePaths.length} file(s). Use {{file}} to refer to the current file's path.`,
				allowFreeform: true,
			});
			inputModal.open();
			const {answer} = await inputModal.promise;
			if (!answer) {
				new Notice('Synapse: no instruction provided — batch loop cancelled.');
				return;
			}

			const budget = await promptForBudget(plugin);

			const handle = new BatchLoopHandle();
			const stopNotice = showStopNotice(handle);
			try {
				await runBatchLoop(plugin, filePaths, answer, handle, undefined, budget);
			} finally {
				stopNotice.hide();
			}
		})();
	}).open();
}

/**
 * Prompt the user for an optional budget cap before the run starts
 * (#74/AC-1): a max token count, a max dollar spend (e.g. `$5`), or empty/
 * `none` to skip. Re-prompts on unparseable input rather than silently
 * treating a typo as "no budget". Cancelling the modal (empty answer) is
 * treated the same as `none` — most users will not want a budget, and a
 * budget is opt-in additive safety, not a required step.
 */
async function promptForBudget(plugin: SynapsePlugin): Promise<BatchLoopBudget | undefined> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const budgetModal = new UserInputModal(plugin.app, {
			question: attempt === 0
				? 'Optional: set a budget cap for this run (e.g. "500000" tokens or "$5"). Leave blank or type "none" to run without a cap.'
				: 'Could not parse that budget. Try e.g. "500000" (tokens) or "$5" (dollars), or leave blank for no cap.',
			allowFreeform: true,
		});
		budgetModal.open();
		const {answer} = await budgetModal.promise;
		const budget = parseBudgetInput(answer);
		if (budget !== null) {
			return budget;
		}
		// budget === null → unparseable non-empty input; re-prompt.
	}
	// Give up after a few failed attempts rather than looping forever — run
	// without a budget (the safe default, matches #73's original behavior).
	new Notice('Synapse: could not parse a budget after several attempts — running without a budget cap.');
	return undefined;
}
