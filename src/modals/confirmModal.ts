import {App, Modal, Setting} from 'obsidian';

/** Small confirm/cancel dialog. Use `ask()`: it resolves true only when the confirm button is pressed. */
export class ConfirmModal extends Modal {
	private confirmed = false;
	private resolve: (confirmed: boolean) => void = () => {};

	private constructor(
		app: App,
		private readonly title: string,
		private readonly body: string[],
		private readonly confirmLabel: string,
	) {
		super(app);
	}

	static ask(app: App, title: string, body: string[], confirmLabel: string): Promise<boolean> {
		return new Promise(resolve => {
			const modal = new ConfirmModal(app, title, body, confirmLabel);
			modal.resolve = resolve;
			modal.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.createEl('h3', {cls: 'synapse-modal-title', text: this.title});
		for (const line of this.body) contentEl.createEl('p', {text: line});
		new Setting(contentEl)
			.addButton(button => button.setButtonText('Keep mine').onClick(() => this.close()))
			.addButton(button => button
				.setButtonText(this.confirmLabel)
				.setWarning()
				.onClick(() => {
					this.confirmed = true;
					this.close();
				}));
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.confirmed);
	}
}
