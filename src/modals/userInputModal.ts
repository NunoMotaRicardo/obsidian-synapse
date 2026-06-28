import {App, Modal} from 'obsidian';

export interface UserInputRequest {
	question: string;
	choices?: string[];
	allowFreeform?: boolean;
}

export interface UserInputResponse {
	answer: string;
	wasFreeform: boolean;
}

export class UserInputModal extends Modal {
	private resolved = false;
	private resolve!: (result: UserInputResponse) => void;
	private readonly request: UserInputRequest;
	readonly promise: Promise<UserInputResponse>;

	constructor(app: App, request: UserInputRequest) {
		super(app);
		this.request = request;
		this.promise = new Promise<UserInputResponse>((res) => {
			this.resolve = res;
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('sidekick-userinput-modal');

		contentEl.createEl('h3', {text: 'Copilot needs your input'});

		contentEl.createDiv({cls: 'sidekick-userinput-question', text: this.request.question});

		const allowFreeform = this.request.allowFreeform !== false; // default true

		// Choice buttons
		if (this.request.choices && this.request.choices.length > 0) {
			const choicesContainer = contentEl.createDiv({cls: 'sidekick-userinput-choices'});
			for (const choice of this.request.choices) {
				const btn = choicesContainer.createEl('button', {cls: 'sidekick-userinput-choice', text: choice});
				btn.addEventListener('click', () => {
					this.resolved = true;
					this.resolve({answer: choice, wasFreeform: false});
					this.close();
				});
			}
		}

		// Freeform text input
		if (allowFreeform) {
			const inputContainer = contentEl.createDiv({cls: 'sidekick-userinput-freeform'});
			const input = inputContainer.createEl('textarea', {
				cls: 'sidekick-userinput-textarea',
				attr: {placeholder: 'Type your answer…', rows: '3'},
			});

			const btnRow = inputContainer.createDiv({cls: 'sidekick-userinput-buttons'});
			const submitBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Submit'});
			submitBtn.addEventListener('click', () => {
				const answer = input.value.trim();
				if (!answer) return;
				this.resolved = true;
				this.resolve({answer, wasFreeform: true});
				this.close();
			});

			// Submit on Enter (Shift+Enter for newline)
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					submitBtn.click();
				}
			});

			// Auto-focus the textarea
			setTimeout(() => input.focus(), 50);
		}
	}

	onClose(): void {
		if (!this.resolved) {
			// Cancelled — return empty answer so the agent can handle it
			this.resolve({answer: '', wasFreeform: true});
		}
	}
}
