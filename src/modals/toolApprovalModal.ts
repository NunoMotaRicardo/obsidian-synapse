import {App, Modal} from 'obsidian';
import type {PermissionResult, PermissionUpdate} from '../copilot';

export interface ToolApprovalRequest {
	toolName: string;
	input: Record<string, unknown>;
	title?: string;
	displayName?: string;
	description?: string;
	suggestions?: PermissionUpdate[];
	toolUseID: string;
}

export class ToolApprovalModal extends Modal {
	private resolved = false;
	private resolve!: (result: PermissionResult) => void;
	private readonly request: ToolApprovalRequest;
	readonly promise: Promise<PermissionResult>;

	constructor(app: App, request: ToolApprovalRequest) {
		super(app);
		this.request = request;
		this.promise = new Promise<PermissionResult>((res) => {
			this.resolve = res;
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('claude-brain-approval-modal');

		contentEl.createEl('h3', {text: 'Tool approval required'});

		const info = contentEl.createDiv({cls: 'claude-brain-approval-info'});
		if (this.request.title) {
			info.createDiv({cls: 'claude-brain-approval-row', text: this.request.title});
		} else {
			info.createDiv({cls: 'claude-brain-approval-row', text: `Tool: ${this.request.toolName}`});
		}
		if (this.request.description) {
			info.createDiv({cls: 'claude-brain-approval-row', text: this.request.description});
		}

		// Show input details
		const inputKeys = Object.keys(this.request.input);
		if (inputKeys.length > 0) {
			const pre = info.createEl('pre', {cls: 'claude-brain-approval-details'});
			pre.createEl('code', {text: JSON.stringify(this.request.input, null, 2)});
		}

		const btnRow = contentEl.createDiv({cls: 'claude-brain-approval-buttons'});

		const allowBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Allow'});
		allowBtn.addEventListener('click', () => {
			this.resolved = true;
			this.resolve({
				behavior: 'allow',
				...(this.request.suggestions ? {updatedPermissions: this.request.suggestions} : {}),
			});
			this.close();
		});

		const denyBtn = btnRow.createEl('button', {text: 'Deny'});
		denyBtn.addEventListener('click', () => {
			this.resolved = true;
			this.resolve({behavior: 'deny', message: 'Denied by user'});
			this.close();
		});
	}

	onClose(): void {
		if (!this.resolved) {
			this.resolve({behavior: 'deny', message: 'Denied by user'});
		}
	}
}
