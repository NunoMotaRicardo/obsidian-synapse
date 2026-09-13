import {App, Modal, Notice, TextComponent} from 'obsidian';

/** Options for `promptModal` — one labelled text input plus go/cancel buttons. */
export interface PromptModalOptions {
	/** Modal title (masthead). */
	title: string;
	/** Description paragraph shown above the input (`.synapse-menu-modal-desc`). */
	description: string;
	/** Placeholder for the text input. */
	placeholder: string;
	/** Label for the primary (CTA) button. */
	goLabel: string;
	/** Optional label element inserted between the description and the input. */
	inputLabel?: {text: string; cls: string};
	/**
	 * When set, an empty (trimmed) input shows this Notice and does not submit —
	 * the modal stays open, matching the required-prompt modals' behaviour.
	 */
	requiredNotice?: string;
	/** Focus the text input after opening (default true). */
	focusInput?: boolean;
	/** Called with the trimmed input after the modal closes. */
	onSubmit: (text: string) => void;
}

/**
 * Build and open the text-prompt modal shared by the editor menu's five modals —
 * new note, new canvas, ask about image, edit the note, structure and refine
 * (issue #238). Keeps the shared CSS classes (`.synapse-menu-modal-desc`,
 * `.synapse-modal-text-input`, `.modal-button-container`, `.mod-cta`), wires
 * Enter via `modal.scope.register` to the primary button, and focuses the input
 * on open. Returns the `Modal` so callers can close it inside their callback
 * if needed; `onSubmit` receives the trimmed text after the modal closes.
 */
export function promptModal(app: App, options: PromptModalOptions): Modal {
	const modal = new Modal(app);
	modal.titleEl.setText(options.title);

	modal.contentEl.createEl('p', {
		text: options.description,
		cls: 'synapse-menu-modal-desc',
	});

	if (options.inputLabel) {
		modal.contentEl.createEl('label', {text: options.inputLabel.text, cls: options.inputLabel.cls});
	}

	const tc = new TextComponent(modal.contentEl);
	tc.inputEl.classList.add('synapse-modal-text-input');
	tc.setPlaceholder(options.placeholder);

	const btnRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
	const goBtn = btnRow.createEl('button', {text: options.goLabel, cls: 'mod-cta'});
	const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});

	const submit = (): void => {
		const text = tc.getValue().trim();
		if (options.requiredNotice && !text) {
			new Notice(options.requiredNotice);
			return;
		}
		modal.close();
		options.onSubmit(text);
	};
	goBtn.addEventListener('click', submit);
	cancelBtn.addEventListener('click', () => modal.close());

	modal.scope.register([], 'Enter', () => { goBtn.click(); return false; });

	modal.open();
	if (options.focusInput !== false) tc.inputEl.focus();

	return modal;
}