import {App, Modal} from 'obsidian';
import {extractAllowRuleStrings, permissionRuleToString, sessionScopePermissions, type PermissionResult, type PermissionUpdate} from '../agentService';

export interface ToolApprovalRequest {
	toolName: string;
	input: Record<string, unknown>;
	title?: string;
	displayName?: string;
	description?: string;
	suggestions?: PermissionUpdate[];
	toolUseID: string;
}

/**
 * Outcome of a `ToolApprovalModal` — the SDK-facing `PermissionResult` plus what (if anything)
 * should be persisted to `_synapse/settings.json` (issue #197). `persistRules` is empty for both
 * **Allow** (#193's original, conversation-scoped, writes nothing — AC-2) and **Deny**; only
 * **Always allow** sets it. The modal itself never touches disk — `SynapseView.buildSessionConfig()`'s
 * `permissionHandler` is the one that calls `configWriter.persistToolApprovalRules()` with these
 * strings, per the `configWriter.ts` file-writing rule in `CLAUDE.md`.
 */
export interface ToolApprovalOutcome {
	result: PermissionResult;
	/** Rule string(s) to persist into `_synapse/settings.json`; empty unless **Always allow** was chosen. */
	persistRules: string[];
}

export class ToolApprovalModal extends Modal {
	private resolved = false;
	private resolve!: (outcome: ToolApprovalOutcome) => void;
	private readonly request: ToolApprovalRequest;
	readonly promise: Promise<ToolApprovalOutcome>;

	constructor(app: App, request: ToolApprovalRequest) {
		super(app);
		this.request = request;
		this.promise = new Promise<ToolApprovalOutcome>((res) => {
			this.resolve = res;
		});
	}

	/**
	 * Rule string(s) an **Always allow** click would persist — the same derivation
	 * `extractAllowRuleStrings()` uses for the in-memory session accumulator (AC-4), so what's
	 * shown in the modal is exactly what ends up on disk. Falls back to a bare `toolName` rule
	 * (`permissionRuleToString()`'s no-`ruleContent` form) when the CLI sent no `addRules`
	 * suggestion to derive a narrower one from, so **Always allow** is never a silent no-op.
	 */
	private persistRuleStrings(): string[] {
		const fromSuggestions = this.request.suggestions ? extractAllowRuleStrings(this.request.suggestions) : [];
		if (fromSuggestions.length > 0) return fromSuggestions;
		return [permissionRuleToString({toolName: this.request.toolName})];
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('synapse-approval-modal');

		contentEl.createEl('h3', {text: 'Tool approval required'});

		const info = contentEl.createDiv({cls: 'synapse-approval-info'});
		if (this.request.title) {
			info.createDiv({cls: 'synapse-approval-row', text: this.request.title});
		} else {
			info.createDiv({cls: 'synapse-approval-row', text: `Tool: ${this.request.toolName}`});
		}
		if (this.request.description) {
			info.createDiv({cls: 'synapse-approval-row', text: this.request.description});
		}

		// Show input details
		const inputKeys = Object.keys(this.request.input);
		if (inputKeys.length > 0) {
			const pre = info.createEl('pre', {cls: 'synapse-approval-details'});
			pre.createEl('code', {text: JSON.stringify(this.request.input, null, 2)});
		}

		const rules = this.persistRuleStrings();

		// Show the literal rule string(s) an "Always allow" click would persist, before the user
		// can click it (issue #197) -- the CLI's own suggestion for an out-of-vault read can be a
		// drive-wide `Read(//d//**)`, the exact shape that started #193; the user must see what
		// they're about to make permanent.
		const scopeInfo = contentEl.createDiv({cls: 'synapse-approval-info'});
		const allowRow = scopeInfo.createDiv({cls: 'synapse-approval-row'});
		allowRow.createEl('strong', {text: 'Allow'});
		allowRow.appendText(' grants this tool for the current conversation only, and writes nothing to disk.');
		const alwaysRow = scopeInfo.createDiv({cls: 'synapse-approval-row'});
		alwaysRow.createEl('strong', {text: 'Always allow'});
		alwaysRow.appendText(' permanently grants, by writing to _synapse/settings.json in this vault:');
		const rulesPre = scopeInfo.createEl('pre', {cls: 'synapse-approval-details'});
		rulesPre.createEl('code', {text: rules.join('\n')});

		const btnRow = contentEl.createDiv({cls: 'synapse-approval-buttons'});

		const allowBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Allow'});
		allowBtn.addEventListener('click', () => {
			this.finish({
				result: {
					behavior: 'allow',
					updatedInput: this.request.input,
					...(this.request.suggestions ? {updatedPermissions: sessionScopePermissions(this.request.suggestions)} : {}),
				},
				persistRules: [],
			});
		});

		const alwaysAllowBtn = btnRow.createEl('button', {text: 'Always allow'});
		alwaysAllowBtn.addEventListener('click', () => {
			this.finish({
				result: {
					behavior: 'allow',
					updatedInput: this.request.input,
					...(this.request.suggestions ? {updatedPermissions: sessionScopePermissions(this.request.suggestions)} : {}),
				},
				persistRules: rules,
			});
		});

		const denyBtn = btnRow.createEl('button', {text: 'Deny'});
		denyBtn.addEventListener('click', () => {
			this.finish({result: {behavior: 'deny', message: 'Denied by user'}, persistRules: []});
		});
	}

	private finish(outcome: ToolApprovalOutcome): void {
		this.resolved = true;
		this.resolve(outcome);
		this.close();
	}

	onClose(): void {
		if (!this.resolved) {
			this.resolve({result: {behavior: 'deny', message: 'Denied by user'}, persistRules: []});
		}
	}
}
