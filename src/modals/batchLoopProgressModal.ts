import {App, Modal} from 'obsidian';
import type {BatchLoopBudget, BatchLoopHandle, BatchLoopProgress, BatchLoopResult, BatchLoopUsage} from '../batchLoopExecutor';

/**
 * Dedicated progress UI for a running batch loop (#75), replacing the plain
 * per-file `Notice`s from #73/#74 with a modal that stays open and updates
 * live: current file, N/total processed, and elapsed budget (tokens or $
 * spent vs. cap, when a budget is set).
 *
 * Lifecycle:
 * - Opened by `launchBatchLoop()` once the scope/instruction/budget prompts
 *   resolve, before `runBatchLoop()` starts.
 * - `updateProgress()` is called from the loop's `onProgress` callback after
 *   each file starts, and again with fresh cumulative usage as results come
 *   back — no close/reopen needed (AC-2).
 * - `showCompletion()` is called once `runBatchLoop()` resolves, rendering a
 *   summary consistent with the `### Run summary` block written to
 *   `_synapse/reports/` (AC-4). The modal is left open afterward — a "Close"
 *   button is shown, but nothing auto-closes it.
 *
 * Cancellation: the "Cancel" button is the *only* control wired to
 * `handle.stop()` (AC-3). Dismissing the modal any other way — the built-in
 * `x`, Escape, or a backdrop click, all of which route through `onClose()` —
 * must NOT stop the loop (AC-5), so `onClose()` intentionally does nothing
 * beyond Obsidian's own DOM cleanup.
 */
export class BatchLoopProgressModal extends Modal {
	private readonly handle: BatchLoopHandle;
	private readonly total: number;
	private readonly budget?: BatchLoopBudget;

	private statusEl!: HTMLElement;
	private progressMeter!: HTMLElement;
	private progressFill!: HTMLElement;
	private fileEl!: HTMLElement;
	private budgetEl!: HTMLElement;
	private buttonRow!: HTMLElement;
	private cancelBtn?: HTMLButtonElement;

	private completed = false;

	constructor(app: App, handle: BatchLoopHandle, total: number, budget?: BatchLoopBudget) {
		super(app);
		this.handle = handle;
		this.total = total;
		this.budget = budget;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass('synapse-batch-progress-modal');

		contentEl.createEl('h3', {cls: 'synapse-modal-title', text: 'Batch loop running'});

		this.statusEl = contentEl.createDiv({cls: 'synapse-batch-progress-status'});
		this.progressMeter = contentEl.createDiv({cls: 'synapse-batch-progress-meter synapse-gauge-track'});
		this.progressFill = this.progressMeter.createDiv({cls: 'synapse-batch-progress-fill synapse-gauge-fill'});
		this.progressFill.setCssProps({'--progress-width': '0%'});
		this.fileEl = contentEl.createDiv({cls: 'synapse-batch-progress-file'});
		this.budgetEl = contentEl.createDiv({cls: 'synapse-batch-progress-budget'});

		this.statusEl.setText(`0/${this.total} processed`);
		this.fileEl.setText('Starting…');
		this.renderBudget({totalTokens: 0, totalCostUsd: 0});

		this.buttonRow = contentEl.createDiv({cls: 'synapse-batch-progress-buttons'});
		this.cancelBtn = this.buttonRow.createEl('button', {text: 'Cancel'});
		this.cancelBtn.addEventListener('click', () => {
			this.handle.stop();
			this.cancelBtn!.disabled = true;
			this.cancelBtn!.setText('Stopping…');
		});
	}

	/** Called from the loop's `onProgress` hook, before and after each file. */
	updateProgress(progress: BatchLoopProgress, usage: BatchLoopUsage): void {
		if (this.completed) return;
		const done = progress.phase === 'done' ? progress.index : progress.index - 1;
		this.statusEl.setText(`${done}/${progress.total} processed`);
		const pct = this.total > 0 ? Math.min(100, Math.round((done / this.total) * 100)) : 0;
		this.progressFill.setCssProps({'--progress-width': `${pct}%`});
		this.fileEl.setText(
			progress.phase === 'done' ? `Finished: ${progress.filePath}` : `Processing: ${progress.filePath}`,
		);
		this.renderBudget(usage);
	}

	/** Called once the loop resolves, with the final result and usage totals. */
	showCompletion(result: BatchLoopResult, usage: BatchLoopUsage): void {
		this.completed = true;

		const attempted = result.processed + result.failed;
		this.statusEl.setText(`${attempted}/${this.total} attempted`);
		const pct = this.total > 0 ? Math.min(100, Math.round((attempted / this.total) * 100)) : 0;
		this.progressFill.setCssProps({'--progress-width': `${pct}%`});
		this.renderBudget(usage);

		this.fileEl.empty();
		this.fileEl.createEl('h4', {text: 'Run summary'});
		const summary = this.fileEl.createDiv();
		summary.createDiv({text: `Status: ${this.describeReason(result)}`});
		summary.createDiv({text: `Files processed: ${result.processed}`});
		summary.createDiv({text: `Files failed: ${result.failed}`});
		summary.createDiv({text: `Files skipped/remaining: ${result.skipped}`});
		summary.createDiv({text: `Total files in scope: ${this.total}`});

		this.buttonRow.empty();
		this.cancelBtn = undefined;
		const closeBtn = this.buttonRow.createEl('button', {text: 'Close', cls: 'mod-cta'});
		closeBtn.addEventListener('click', () => this.close());
	}

	private renderBudget(usage: BatchLoopUsage): void {
		if (!this.budget) {
			this.budgetEl.setText('Budget: no cap');
			return;
		}
		if (this.budget.type === 'dollars') {
			this.budgetEl.setText(`Budget: $${usage.totalCostUsd.toFixed(4)} / $${this.budget.max.toFixed(2)}`);
		} else {
			this.budgetEl.setText(
				`Budget: ${usage.totalTokens.toLocaleString()} / ${this.budget.max.toLocaleString()} tokens`,
			);
		}
	}

	private describeReason(result: BatchLoopResult): string {
		switch (result.reason) {
			case 'completed':
				return `completed${result.failed > 0 ? ` (${result.failed} failed)` : ''}`;
			case 'cancelled':
				return 'stopped by user (cancelled)';
			case 'budget-exceeded':
				return `stopped — budget exhausted${this.budget ? ` (limit: ${this.budget.type === 'dollars' ? `$${this.budget.max.toFixed(2)}` : `${this.budget.max.toLocaleString()} tokens`})` : ''}`;
			case 'scope-too-large':
				return 'scope exceeded the file-count limit before the run started';
		}
	}

	onClose(): void {
		// Intentionally does not call `this.handle.stop()` — dismissing the
		// modal via the built-in `x`, Escape, or a backdrop click must not stop
		// an in-flight loop (AC-5). Only the "Cancel" button above does that.
		this.contentEl.empty();
	}
}
