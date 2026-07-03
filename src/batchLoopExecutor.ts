/**
 * Batch loop executor — runs a single user-supplied prompt sequentially over a
 * chosen set of vault files ("batch loop"), calling the configured agent once
 * per file and recording results.
 *
 * User-initiated (command palette), plugin-orchestrated iteration — mirrors
 * `src/triggerExecutor.ts`'s model-routing and report-writing pattern. This is
 * the foundational slice (#73) of the Tier-2 batch-loops feature (#66).
 * Budget caps and true in-flight cancellation (#74) build on the extension
 * points (`onProgress`, `BatchLoopHandle`) that #73 left in place for them.
 * The plain per-file `Notice`s from #73/#74 have been replaced by a dedicated
 * progress modal (`BatchLoopProgressModal`, #75) that shows live progress and
 * elapsed budget for the duration of the run.
 */

import {App, Notice, TFile, TFolder, normalizePath} from 'obsidian';
import type SynapsePlugin from './main';
import type {SDKResultMessage} from './agentService';
import {SYNAPSE_FOLDER} from './settings';
import {ensureFolder} from './configWriter';
import type {Budget, BudgetUsage} from './budget';
import {parseBudgetInput as parseBudgetInputShared, describeBudget, budgetExceeded} from './budget';
import {lockManager} from './lockManager';
import {BatchLoopProgressModal} from './modals/batchLoopProgressModal';
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
 *
 * Alias of the shared `Budget`/`BudgetUsage` types (`src/budget.ts`, extracted
 * in #88 so the interactive chat-view turn/cost thresholds can reuse the same
 * parse/describe/exceeded helpers instead of duplicating them).
 */
export type BatchLoopBudget = Budget;

/** Re-exported from `src/budget.ts` — see there for parsing rules. */
export const parseBudgetInput = parseBudgetInputShared;

/** Sum the token fields Anthropic reports as "usage" for a result message. */
function totalTokensForResult(usage: SDKResultMessage['usage']): number {
	return (
		(usage.input_tokens ?? 0) +
		(usage.output_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0)
	);
}

/**
 * Cumulative usage/cost tracked across a batch loop run, for budget
 * enforcement. Alias of the shared `BudgetUsage` type (`src/budget.ts`).
 */
export type BatchLoopUsage = BudgetUsage;

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
 *
 * The whole read-modify-write is wrapped in `lockManager.withLock` on the
 * report path so a batch loop's per-file/run-summary appends can't interleave
 * with another plugin-initiated write to the same day's report (e.g. a
 * trigger reporting to the same file, or another batch-loop run). A
 * `LockAcquisitionError` (wedged holder) propagates to the caller — batch
 * loop per-file errors are already caught and reported per-file by
 * `runBatchLoop()`'s loop body, so a lock timeout here surfaces the same way
 * an ordinary write failure would.
 */
async function appendBlockToReport(plugin: SynapsePlugin, block: string): Promise<void> {
	const app = plugin.app;

	const today = todayString();
	const reportPath = normalizePath(`${REPORTS_FOLDER}/${REPORT_NAME}-${today}.md`);
	const heading = `# ${REPORT_NAME} — ${today}`;

	await lockManager.withLock(reportPath, async () => {
		await ensureFolder(app, REPORTS_FOLDER);

		const exists = await app.vault.adapter.exists(reportPath);
		if (!exists) {
			await app.vault.create(reportPath, `${heading}\n\n${block}\n`);
		} else {
			const tfile = app.vault.getAbstractFileByPath(reportPath) as TFile;
			const current = await app.vault.read(tfile);
			await app.vault.modify(tfile, `${current}\n${block}\n`);
		}
	});
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
	/**
	 * Whether this call marks the file *starting* (usage does not yet include
	 * it) or *done* (usage includes its result) — lets a live UI distinguish
	 * "N-1/total processed, now starting N" from "N/total processed".
	 */
	phase: 'starting' | 'done';
}

/**
 * Cumulative usage-so-far, passed alongside each `onProgress` call so a
 * caller (e.g. #75's `BatchLoopProgressModal`) can show elapsed budget live
 * without re-deriving it from individual `SDKResultMessage`s itself.
 * `onProgress` fires twice per file: once with `phase: 'starting'`, where
 * usage does not yet include the in-flight file, and again with
 * `phase: 'done'`, where usage includes that file's own result.
 */
export type BatchLoopOnProgress = (progress: BatchLoopProgress, usage: BatchLoopUsage) => void;

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
 * - Progress is forwarded to the optional `onProgress` hook (paired with
 *   cumulative usage-so-far) after each file starts *and* again once that
 *   file's result comes back, so a live progress UI (#75) can show elapsed
 *   budget without re-deriving it from `SDKResultMessage`s itself.
 * - Errors for an individual file are caught, logged, and appended to the
 *   report under an `### Error` heading — one failing file does not abort
 *   the rest of the run.
 */
export async function runBatchLoop(
	plugin: SynapsePlugin,
	filePaths: string[],
	instruction: string,
	handle: BatchLoopHandle,
	onProgress?: BatchLoopOnProgress,
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

		onProgress?.({index, total, filePath, phase: 'starting'}, {...usage});

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
			// Report again with post-file usage so a live UI reflects this
			// file's cost/tokens without waiting for the next file to start.
			onProgress?.({index, total, filePath, phase: 'done'}, {...usage});
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
 * Launch a batch loop from the command palette: open `VaultScopeModal` to
 * pick target files/folders, then `UserInputModal` for the per-file
 * instruction, then run the loop behind a `BatchLoopProgressModal` (#75) that
 * shows live progress/budget and wires its "Cancel" button to
 * `handle.stop()`.
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
			const progressModal = new BatchLoopProgressModal(plugin.app, handle, filePaths.length, budget);
			progressModal.open();

			let lastUsage: BatchLoopUsage = {totalTokens: 0, totalCostUsd: 0};
			const result = await runBatchLoop(plugin, filePaths, answer, handle, (progress, usage) => {
				lastUsage = usage;
				progressModal.updateProgress(progress, usage);
			}, budget);
			progressModal.showCompletion(result, lastUsage);
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
