import {App, Modal} from 'obsidian';
import type {PermissionResult} from '../agentService';

// The Agent SDK's `AskUserQuestionInput` type is a deeply nested tuple union (1-4 questions,
// each with 2-4 options) meant to constrain what the model sends, not to be convenient to
// consume host-side. We work against a structurally-compatible, simpler shape here — every
// concrete `AskUserQuestionInput` the SDK produces satisfies it.
export interface AskUserQuestionOption {
	label: string;
	description: string;
	preview?: string;
}

export interface AskUserQuestionQuestion {
	question: string;
	header: string;
	options: AskUserQuestionOption[];
	multiSelect: boolean;
}

export interface AskUserQuestionInputLike {
	questions: AskUserQuestionQuestion[];
}

interface QuestionAnswerState {
	/** Selected option labels (single-select: at most one; multi-select: any number). */
	selectedLabels: Set<string>;
	/** Whether the "Other" option is selected. */
	otherSelected: boolean;
	/** The typed "Other" free-text value. */
	otherText: string;
}

/**
 * Pure mapping from an `AskUserQuestionInput`-shaped payload plus per-question UI selection state
 * to the `answers`/`annotations` maps the CLI expects (issue #182 — verified against the live
 * CLI): `answers` is keyed by the **question text**, valued by the selected option's **label**
 * (multi-select joins labels with `", "`); an "Other" answer is the typed string as-is.
 * `annotations[question].preview` is populated when a single non-"Other" option carrying a
 * `preview` was selected for a single-select question (multi-select/Other/no-preview omit it).
 * Exported standalone (no DOM/Obsidian dependency) so it's unit-testable without a vault.
 */
export function buildAskUserQuestionAnswers(
	questions: AskUserQuestionQuestion[],
	states: Map<string, QuestionAnswerState>,
): {answers: Record<string, string>; annotations: Record<string, {preview?: string}>} {
	const answers: Record<string, string> = {};
	const annotations: Record<string, {preview?: string}> = {};

	for (const q of questions) {
		const state = states.get(q.question);
		if (!state) continue;

		const labels: string[] = [];
		if (state.otherSelected && state.otherText.trim()) {
			labels.push(state.otherText.trim());
		}
		for (const opt of q.options) {
			if (state.selectedLabels.has(opt.label)) labels.push(opt.label);
		}
		if (labels.length === 0) continue;

		answers[q.question] = labels.join(', ');

		// Only surface a preview when exactly one, non-"Other" option was selected — a joined
		// multi-select answer or a free-text "Other" answer has no single option's preview to
		// attach.
		if (!q.multiSelect && !state.otherSelected && state.selectedLabels.size === 1) {
			const selectedLabel = [...state.selectedLabels][0];
			const opt = q.options.find(o => o.label === selectedLabel);
			if (opt?.preview) {
				annotations[q.question] = {preview: opt.preview};
			}
		}
	}

	return {answers, annotations};
}

export type {QuestionAnswerState};

/**
 * Modal that renders the `AskUserQuestion` tool's questions (1-4, each with 2-4 options plus a
 * host-supplied "Other" free-text option) and resolves to a `PermissionResult` — `allow` with
 * `updatedInput` carrying `answers`/`annotations` on submit, `deny` on dismissal (AC-5). Mirrors
 * `ElicitationModal`'s promise-resolving structure.
 */
export class AskUserQuestionModal extends Modal {
	private resolved = false;
	private resolve!: (result: PermissionResult) => void;
	private readonly input: AskUserQuestionInputLike;
	private readonly states: Map<string, QuestionAnswerState> = new Map();
	private submitBtn!: HTMLButtonElement;
	readonly promise: Promise<PermissionResult>;

	constructor(app: App, input: AskUserQuestionInputLike) {
		super(app);
		this.input = input;
		this.promise = new Promise<PermissionResult>((res) => {
			this.resolve = res;
		});
		for (const q of input.questions) {
			this.states.set(q.question, {selectedLabels: new Set(), otherSelected: false, otherText: ''});
		}
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('synapse-askq-modal');

		contentEl.createEl('h3', {text: 'Claude has a question'});

		const list = contentEl.createDiv({cls: 'synapse-askq-list'});
		for (const q of this.input.questions) {
			this.renderQuestion(list, q);
		}

		const btnRow = contentEl.createDiv({cls: 'synapse-askq-buttons'});

		this.submitBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Submit'});
		this.submitBtn.addEventListener('click', () => this.submit());

		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => this.finish(false));

		this.updateSubmitState();
	}

	onClose(): void {
		if (!this.resolved) {
			this.finish(false);
		}
	}

	private renderQuestion(parent: HTMLElement, q: AskUserQuestionQuestion): void {
		const wrapper = parent.createDiv({cls: 'synapse-askq-question'});

		const headerRow = wrapper.createDiv({cls: 'synapse-askq-header-row'});
		headerRow.createSpan({cls: 'synapse-askq-chip', text: q.header});
		if (q.multiSelect) {
			headerRow.createSpan({cls: 'synapse-askq-chip synapse-askq-chip-muted', text: 'Select all that apply'});
		}

		wrapper.createDiv({cls: 'synapse-askq-question-text', text: q.question});

		const optionsEl = wrapper.createDiv({cls: 'synapse-askq-options'});

		const state = this.states.get(q.question)!;

		// The options are a radio group (single-select) or a set of checkboxes (multi-select).
		// They are divs rather than native inputs so the label/description/preview can be laid out
		// as a card, which means the roles, focusability and key handling below are what make them
		// reachable at all without a mouse — the modal blocks the agent's turn until it is
		// answered, so a mouse-only UI would strand a keyboard user.
		optionsEl.setAttr('role', q.multiSelect ? 'group' : 'radiogroup');
		optionsEl.setAttr('aria-label', q.question);

		const cards: {label: string; el: HTMLElement}[] = [];

		const applySelectionStyles = (): void => {
			for (const {label, el} of cards) {
				const selected = state.selectedLabels.has(label);
				el.toggleClass('is-selected', selected);
				el.setAttr('aria-checked', String(selected));
			}
			otherCard.toggleClass('is-selected', state.otherSelected);
		};

		/** Move focus between this question's option cards — the arrow keys a radio group expects. */
		const focusCard = (from: HTMLElement, delta: number): void => {
			const index = cards.findIndex(c => c.el === from);
			if (index === -1) return;
			const next = cards[(index + delta + cards.length) % cards.length];
			next?.el.focus();
		};

		for (const opt of q.options) {
			const card = optionsEl.createDiv({cls: 'synapse-askq-option'});
			card.setAttr('role', q.multiSelect ? 'checkbox' : 'radio');
			card.setAttr('tabindex', '0');
			card.setAttr('aria-checked', 'false');
			card.createDiv({cls: 'synapse-askq-option-label', text: opt.label});
			card.createDiv({cls: 'synapse-askq-option-description', text: opt.description});
			cards.push({label: opt.label, el: card});

			const toggle = (): void => {
				if (q.multiSelect) {
					if (state.selectedLabels.has(opt.label)) state.selectedLabels.delete(opt.label);
					else state.selectedLabels.add(opt.label);
				} else {
					state.selectedLabels.clear();
					state.selectedLabels.add(opt.label);
					state.otherSelected = false;
				}
				applySelectionStyles();
				this.updateSubmitState();
			};

			card.addEventListener('click', toggle);
			card.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					// Space would otherwise scroll the modal, and Enter would submit the form.
					e.preventDefault();
					toggle();
				} else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
					e.preventDefault();
					focusCard(card, 1);
				} else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
					e.preventDefault();
					focusCard(card, -1);
				}
			});
		}

		// "Other" free-text option — always offered (AC-3): the model never sends one itself.
		const otherCard = optionsEl.createDiv({cls: 'synapse-askq-option synapse-askq-option-other'});
		otherCard.createDiv({cls: 'synapse-askq-option-label', text: 'Other'});
		// The Other option's control is the text field itself — natively focusable, so it needs a
		// label rather than a role.
		const otherInput = otherCard.createEl('input', {
			type: 'text',
			cls: 'synapse-askq-other-input',
			attr: {placeholder: 'Type your own answer…', 'aria-label': `Other answer for: ${q.question}`},
		});
		otherInput.addEventListener('click', (e) => e.stopPropagation());
		otherCard.addEventListener('click', () => {
			otherInput.focus();
		});
		// Claiming the answer is driven by typed text, never by focus alone: on a single-select
		// question this clears the currently selected option, so a user who merely clicks into the
		// field to consider a custom answer would otherwise lose their pick and find Submit
		// disabled with nothing typed to replace it.
		const selectOther = (): void => {
			if (!q.multiSelect) state.selectedLabels.clear();
			state.otherSelected = true;
			applySelectionStyles();
			this.updateSubmitState();
		};
		otherInput.addEventListener('input', () => {
			state.otherText = otherInput.value;
			if (otherInput.value.trim()) selectOther();
			else {
				state.otherSelected = false;
				applySelectionStyles();
			}
			this.updateSubmitState();
		});

		applySelectionStyles();
	}

	private isAnswered(state: QuestionAnswerState): boolean {
		if (state.otherSelected && state.otherText.trim()) return true;
		return state.selectedLabels.size > 0;
	}

	private updateSubmitState(): void {
		const allAnswered = this.input.questions.every(q => this.isAnswered(this.states.get(q.question)!));
		this.submitBtn.disabled = !allAnswered;
	}

	private submit(): void {
		const {answers, annotations} = buildAskUserQuestionAnswers(this.input.questions, this.states);
		this.resolved = true;
		this.resolve({
			behavior: 'allow',
			updatedInput: {
				...(this.input as unknown as Record<string, unknown>),
				answers,
				...(Object.keys(annotations).length > 0 ? {annotations} : {}),
			},
		});
		this.close();
	}

	private finish(_submitted: false): void {
		this.resolved = true;
		this.resolve({behavior: 'deny', message: 'Denied by user'});
		this.close();
	}
}
