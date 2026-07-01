/**
 * Batch loop executor — runs a single user-supplied prompt sequentially over a
 * chosen set of vault files ("batch loop"), calling the configured agent once
 * per file and recording results.
 *
 * User-initiated (command palette), plugin-orchestrated iteration — mirrors
 * `src/triggerExecutor.ts`'s model-routing and report-writing pattern. This is
 * the foundational slice (#73) of the Tier-2 batch-loops feature (#66); budget
 * caps/cancellation-in-flight and a richer progress UI are later slices
 * (#74, #75).
 */

import {App, Notice, TFile, TFolder, createFragment, normalizePath} from 'obsidian';
import type SynapsePlugin from './main';
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
 * Append a result block to today's batch-loop report file.
 *
 * Report path: `_synapse/reports/batch-loop-YYYY-MM-DD.md`. Created with a
 * `# batch-loop — YYYY-MM-DD` heading if absent for today, otherwise appended
 * (uses vault.read()/vault.modify() so the Obsidian cache and internal file
 * queue stay consistent — same rationale as the trigger executor).
 */
async function appendToReport(
	plugin: SynapsePlugin,
	filePath: string,
	result: string,
	isError = false,
): Promise<void> {
	const app = plugin.app;
	await ensureFolder(app, REPORTS_FOLDER);

	const today = todayString();
	const reportPath = normalizePath(`${REPORTS_FOLDER}/${REPORT_NAME}-${today}.md`);

	const heading = `# ${REPORT_NAME} — ${today}`;
	const entryHeading = `## ${filePath}`;
	const block = isError ? `${entryHeading}\n\n### Error\n\n${result}` : `${entryHeading}\n\n${result}`;

	const exists = await app.vault.adapter.exists(reportPath);
	if (!exists) {
		await app.vault.create(reportPath, `${heading}\n\n${block}\n`);
	} else {
		const tfile = app.vault.getAbstractFileByPath(reportPath) as TFile;
		const current = await app.vault.read(tfile);
		await app.vault.modify(tfile, `${current}\n${block}\n`);
	}
}

// ---------------------------------------------------------------------------
// Model execution
// ---------------------------------------------------------------------------

/**
 * Execute the instruction for a single file via AgentService.inlineChat().
 * Same routing pattern as `executeTrigger()`'s Claude path — this slice
 * always routes through Claude (local-model routing for batch loops is not
 * in scope for #73).
 */
async function runOnFile(
	plugin: SynapsePlugin,
	instruction: string,
	filePath: string,
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
		cwd: basePath,
		plugins: [{type: 'local', path: pluginsPath}],
		maxTurns: 10,
		permissionMode: 'default',
	});

	return result.content ?? '';
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * Mutable handle allowing a caller (e.g. a "Stop" Notice button) to request
 * cancellation of an in-flight batch loop. Cancellation is cooperative: the
 * loop checks `cancelled` between files and halts before starting the next
 * one, it does not abort a file currently in progress.
 */
export class BatchLoopHandle {
	cancelled = false;

	stop(): void {
		this.cancelled = true;
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

export interface BatchLoopResult {
	processed: number;
	failed: number;
	skipped: number;
	cancelled: boolean;
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
 * - Cooperative cancellation via `handle.stop()` (checked between files).
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
): Promise<BatchLoopResult> {
	if (filePaths.length > BATCH_LOOP_MAX_FILES) {
		const skipped = filePaths.length - BATCH_LOOP_MAX_FILES;
		new Notice(
			`Synapse: batch loop scope has ${filePaths.length} files, exceeding the limit of ` +
			`${BATCH_LOOP_MAX_FILES}. Narrow the selection and try again. (${skipped} file${skipped === 1 ? '' : 's'} skipped.)`,
			10000,
		);
		return {processed: 0, failed: 0, skipped, cancelled: false};
	}

	const total = filePaths.length;
	let processed = 0;
	let failed = 0;

	for (let i = 0; i < total; i++) {
		if (handle.cancelled) {
			const attempted = processed + failed;
			new Notice(`Synapse: batch loop stopped by user after ${attempted}/${total} file(s).`);
			return {processed, failed, skipped: total - attempted, cancelled: true};
		}

		const filePath = filePaths[i]!;
		const index = i + 1;

		new Notice(`Synapse: processing ${index}/${total}: ${filePath}`);
		onProgress?.({index, total, filePath});

		try {
			const result = await runOnFile(plugin, instruction, filePath);
			await appendToReport(plugin, filePath, result);
			processed++;
			console.log(`[synapse] Batch loop processed ${filePath} (${index}/${total})`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`[synapse] Batch loop failed for ${filePath}:`, e);
			failed++;
			try {
				await appendToReport(plugin, filePath, msg, true);
			} catch (reportErr) {
				console.error('[synapse] Failed to write batch loop error report:', reportErr);
			}
		}
	}

	new Notice(`Synapse: batch loop finished — ${processed}/${total} file(s) processed${failed > 0 ? `, ${failed} failed` : ''}.`);
	return {processed, failed, skipped: 0, cancelled: false};
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
	const fragment = createFragment((el) => {
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

			const handle = new BatchLoopHandle();
			const stopNotice = showStopNotice(handle);
			try {
				await runBatchLoop(plugin, filePaths, answer, handle);
			} finally {
				stopNotice.hide();
			}
		})();
	}).open();
}
