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
	/**
	 * CLI/SDK 0.3.281 hint (issue #268): "the ask must not be approvable by a single stray
	 * keystroke" — the modal must open with **Deny** focused and must not give **Allow** the
	 * default-button (`mod-cta`) styling, so Enter/Space right after the modal opens denies
	 * rather than approves.
	 */
	defaultToNo?: boolean;
	/**
	 * CLI/SDK 0.3.281 hint (issue #268): "the rule it would write grants more than this ask's
	 * own action" — the modal must not offer a persistent "don't ask again" choice at all. Both
	 * the **Always allow** button/rule-preview and `updatedPermissions` on a plain **Allow**
	 * (which would otherwise widen this one approval into a `'session'`-scope rule via
	 * `sessionScopePermissions()`) are suppressed; only a single-call `{behavior: 'allow',
	 * updatedInput}` is offered.
	 */
	suppressAlwaysAllowRule?: boolean;
}

/**
 * Pure hint → presentation mapping for `ToolApprovalModal` (issue #268) — kept DOM-free so it's
 * unit-testable without Obsidian (see `test/toolApprovalModal.test.ts`), mirroring
 * `buildAskUserQuestionAnswers()`'s pattern in `askUserQuestionModal.ts`.
 */
export interface ToolApprovalPresentation {
	/**
	 * Whether to render the **Always allow** button and the rule-preview block at all. False
	 * when `suppressAlwaysAllowRule` is set — the CLI has already ruled out a permanent rule for
	 * this ask.
	 */
	showAlwaysAllow: boolean;
	/** Sentence-case note shown in place of the rule preview when `showAlwaysAllow` is false. */
	suppressedNote?: string;
	/**
	 * Whether **Allow** (and **Always allow**, when shown) should attach `updatedPermissions` —
	 * a `'session'`-scope rule broader than this single call. False when `suppressAlwaysAllowRule`
	 * is set, so **Allow** approves only the one call in front of the user.
	 */
	allowUpdatedPermissions: boolean;
	/** Which button should receive initial keyboard focus when the modal opens. */
	focusButton: 'allow' | 'deny';
	/** Whether **Allow** gets the `mod-cta` default-button styling. */
	allowIsDefaultCta: boolean;
}

export function resolveToolApprovalPresentation(hints: {defaultToNo?: boolean; suppressAlwaysAllowRule?: boolean}): ToolApprovalPresentation {
	const suppressAlwaysAllow = hints.suppressAlwaysAllowRule === true;
	const defaultToNo = hints.defaultToNo === true;
	return {
		showAlwaysAllow: !suppressAlwaysAllow,
		suppressedNote: suppressAlwaysAllow ? "Claude Code doesn't allow a permanent rule for this action." : undefined,
		allowUpdatedPermissions: !suppressAlwaysAllow,
		focusButton: defaultToNo ? 'deny' : 'allow',
		allowIsDefaultCta: !defaultToNo,
	};
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

		contentEl.createEl('h3', {cls: 'synapse-modal-title', text: 'Tool approval required'});

		const info = contentEl.createDiv({cls: 'synapse-approval-info'});
		if (this.request.title) {
			const row = info.createDiv({cls: 'synapse-approval-row'});
			row.createSpan({cls: 'synapse-approval-tool-name', text: this.request.toolName});
			row.createSpan({text: ` — ${this.request.title}`});
		} else {
			const toolRow = info.createDiv({cls: 'synapse-approval-row'});
			toolRow.createSpan({cls: 'synapse-modal-label', text: 'Tool: '});
			toolRow.createSpan({cls: 'synapse-approval-tool-name', text: this.request.toolName});
		}
		if (this.request.description) {
			info.createDiv({cls: 'synapse-approval-row', text: this.request.description});
		}

		// Show input details
		const inputKeys = Object.keys(this.request.input);
		if (inputKeys.length > 0) {
			const pre = info.createEl('pre', {cls: 'synapse-approval-details synapse-ledger'});
			pre.createEl('code', {text: JSON.stringify(this.request.input, null, 2)});
		}

		const rules = this.persistRuleStrings();
		const presentation = resolveToolApprovalPresentation(this.request);

		// Show the literal rule string(s) an "Always allow" click would persist, before the user
		// can click it (issue #197) -- the CLI's own suggestion for an out-of-vault read can be a
		// drive-wide `Read(//d//**)`, the exact shape that started #193; the user must see what
		// they're about to make permanent.
		const scopeInfo = contentEl.createDiv({cls: 'synapse-approval-info'});
		const allowRow = scopeInfo.createDiv({cls: 'synapse-approval-row'});
		allowRow.createEl('strong', {text: 'Allow'});
		allowRow.appendText(' grants this tool for the current conversation only, and writes nothing to disk.');
		if (presentation.showAlwaysAllow) {
			const alwaysRow = scopeInfo.createDiv({cls: 'synapse-approval-row'});
			alwaysRow.createEl('strong', {text: 'Always allow'});
			alwaysRow.appendText(' permanently grants, by writing to _synapse/settings.json in this vault:');
			const rulesPre = scopeInfo.createEl('pre', {cls: 'synapse-approval-details synapse-ledger'});
			rulesPre.createEl('code', {text: rules.join('\n')});
		} else if (presentation.suppressedNote) {
			// suppressAlwaysAllowRule (issue #268): the CLI has ruled out a permanent rule for this
			// ask (it would grant more than this ask's own action) -- no Always allow button, no
			// rule preview, just a short explanation.
			scopeInfo.createDiv({cls: 'synapse-approval-row', text: presentation.suppressedNote});
		}

		const btnRow = contentEl.createDiv({cls: 'synapse-approval-buttons'});

		const allowBtn = btnRow.createEl('button', {text: 'Allow'});
		if (presentation.allowIsDefaultCta) allowBtn.addClass('mod-cta');
		allowBtn.addEventListener('click', () => {
			this.finish({
				result: {
					behavior: 'allow',
					updatedInput: this.request.input,
					...(presentation.allowUpdatedPermissions && this.request.suggestions
						? {updatedPermissions: sessionScopePermissions(this.request.suggestions)}
						: {}),
				},
				persistRules: [],
			});
		});

		if (presentation.showAlwaysAllow) {
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
		}

		const denyBtn = btnRow.createEl('button', {text: 'Deny'});
		denyBtn.addEventListener('click', () => {
			this.finish({result: {behavior: 'deny', message: 'Denied by user'}, persistRules: []});
		});

		// defaultToNo (issue #268): "must not be approvable by a single stray keystroke" -- focus
		// Deny instead of the browser's default first-focusable-element behavior, so a stray
		// Enter/Space right after the modal opens denies rather than approves.
		(presentation.focusButton === 'deny' ? denyBtn : allowBtn).focus();
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
