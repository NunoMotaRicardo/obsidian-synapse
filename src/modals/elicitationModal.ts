import {App, Modal} from 'obsidian';
import type {ElicitationContext, ElicitationResult} from '../agentService';

// Elicitation schema types — the Agent SDK uses a generic JSON Schema Record
// rather than typed field descriptors. We define compatible shapes here.
type ElicitationSchemaField =
	| {type: 'boolean'; title?: string; description?: string; default?: boolean}
	| {type: 'number' | 'integer'; title?: string; description?: string; default?: number; minimum?: number; maximum?: number}
	| {type: 'string'; title?: string; description?: string; default?: string; enum?: string[]; oneOf?: {const: string; title: string}[]; maxLength?: number; format?: string}
	| {type: 'array'; title?: string; description?: string; default?: string[]; items: {enum?: string[]; anyOf?: {const: string; title: string}[]}};

type ElicitationFieldValue = string | number | boolean | string[];

/**
 * Modal that renders a dynamic form based on an ElicitationContext's requestedSchema.
 * Returns an ElicitationResult (accept/decline/cancel) with collected field values.
 */
export class ElicitationModal extends Modal {
	private resolved = false;
	private resolve!: (result: ElicitationResult) => void;
	private readonly context: ElicitationContext;
	private readonly fieldValues: Map<string, ElicitationFieldValue> = new Map();
	readonly promise: Promise<ElicitationResult>;

	constructor(app: App, context: ElicitationContext) {
		super(app);
		this.context = context;
		this.promise = new Promise<ElicitationResult>((res) => {
			this.resolve = res;
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('synapse-elicitation-modal');

		// Header
		const header = contentEl.createEl('h3', {text: 'Input requested'});
		if (this.context.serverName) {
			header.textContent = `Input requested by ${this.context.serverName}`;
		}

		// Message
		contentEl.createDiv({cls: 'synapse-elicitation-message', text: this.context.message});

		// URL mode — show link instead of form
		if (this.context.mode === 'url' && this.context.url) {
			this.renderUrlMode(contentEl, this.context.url);
			return;
		}

		// Form fields
		const schema = this.context.requestedSchema as {properties?: Record<string, ElicitationSchemaField>; required?: string[]} | undefined;
		if (schema?.properties) {
			const formEl = contentEl.createDiv({cls: 'synapse-elicitation-form'});
			const required = new Set(schema.required ?? []);

			for (const [key, field] of Object.entries(schema.properties)) {
				this.renderField(formEl, key, field as ElicitationSchemaField, required.has(key));
			}
		}

		// Action buttons
		const btnRow = contentEl.createDiv({cls: 'synapse-elicitation-buttons'});

		const submitBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Submit'});
		submitBtn.addEventListener('click', () => this.submit());

		const declineBtn = btnRow.createEl('button', {text: 'Decline'});
		declineBtn.addEventListener('click', () => this.finish('decline'));
	}

	onClose(): void {
		if (!this.resolved) {
			this.finish('cancel');
		}
	}

	private submit(): void {
		const content: Record<string, ElicitationFieldValue> = {};
		for (const [key, value] of this.fieldValues) {
			content[key] = value;
		}
		this.resolved = true;
		this.resolve({action: 'accept', content});
		this.close();
	}

	private finish(action: 'decline' | 'cancel'): void {
		this.resolved = true;
		this.resolve({action});
		this.close();
	}

	/* ── URL mode ────────────────────────────────────────────── */

	private renderUrlMode(parent: HTMLElement, url: string): void {
		const linkRow = parent.createDiv({cls: 'synapse-elicitation-url'});
		const link = linkRow.createEl('a', {text: 'Open in browser', href: url});
		link.setAttr('target', '_blank');
		link.setAttr('rel', 'noopener noreferrer');

		const btnRow = parent.createDiv({cls: 'synapse-elicitation-buttons'});

		const doneBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Done'});
		doneBtn.addEventListener('click', () => {
			this.resolved = true;
			this.resolve({action: 'accept'});
			this.close();
		});

		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => this.finish('cancel'));
	}

	/* ── Field rendering ─────────────────────────────────────── */

	private renderField(parent: HTMLElement, key: string, field: ElicitationSchemaField, _isRequired: boolean): void {
		const wrapper = parent.createDiv({cls: 'synapse-elicitation-field'});

		const label = field.title ?? key;
		wrapper.createEl('label', {text: label, cls: 'synapse-elicitation-label'});

		if (field.description) {
			wrapper.createDiv({cls: 'synapse-elicitation-description', text: field.description});
		}

		switch (field.type) {
			case 'boolean':
				this.renderBooleanField(wrapper, key, field);
				break;
			case 'number':
			case 'integer':
				this.renderNumberField(wrapper, key, field);
				break;
			case 'string':
				this.renderStringField(wrapper, key, field);
				break;
			case 'array':
				this.renderArrayField(wrapper, key, field);
				break;
		}
	}

	private renderBooleanField(parent: HTMLElement, key: string, field: Extract<ElicitationSchemaField, {type: 'boolean'}>): void {
		const toggle = parent.createDiv({cls: 'checkbox-container'});
		const input = toggle.createEl('input', {type: 'checkbox'});
		if (field.default === true) {
			input.checked = true;
			this.fieldValues.set(key, true);
		} else {
			this.fieldValues.set(key, false);
		}
		input.addEventListener('change', () => {
			this.fieldValues.set(key, input.checked);
		});
	}

	private renderNumberField(parent: HTMLElement, key: string, field: Extract<ElicitationSchemaField, {type: 'number' | 'integer'}>): void {
		const input = parent.createEl('input', {
			type: 'number',
			cls: 'synapse-elicitation-input',
		});
		if (field.minimum !== undefined) input.setAttr('min', String(field.minimum));
		if (field.maximum !== undefined) input.setAttr('max', String(field.maximum));
		if (field.type === 'integer') input.setAttr('step', '1');
		if (field.default !== undefined) {
			input.value = String(field.default);
			this.fieldValues.set(key, field.default);
		}
		input.addEventListener('input', () => {
			const v = field.type === 'integer' ? parseInt(input.value, 10) : parseFloat(input.value);
			if (!isNaN(v)) this.fieldValues.set(key, v);
		});
	}

	private renderStringField(parent: HTMLElement, key: string, field: Extract<ElicitationSchemaField, {type: 'string'}>): void {
		// Enum select (with enum or oneOf)
		if ('enum' in field && field.enum) {
			this.renderSelectField(parent, key, field.enum, (field as {enumNames?: string[]}).enumNames, field.default);
			return;
		}

		if ('oneOf' in field && field.oneOf) {
			const opts = (field.oneOf as {const: string; title: string}[]);
			this.renderSelectField(parent, key, opts.map(o => o.const), opts.map(o => o.title), field.default);
			return;
		}

		// Plain text input
		const input = parent.createEl('input', {
			type: 'text',
			cls: 'synapse-elicitation-input',
		});
		if (field.default) {
			input.value = field.default;
			this.fieldValues.set(key, field.default);
		}
		if ('maxLength' in field && field.maxLength) input.setAttr('maxlength', String(field.maxLength));
		if ('format' in field && field.format) {
			input.setAttr('placeholder', field.format);
		}
		input.addEventListener('input', () => {
			this.fieldValues.set(key, input.value);
		});
	}

	private renderArrayField(parent: HTMLElement, key: string, field: Extract<ElicitationSchemaField, {type: 'array'}>): void {
		// Multi-select checkboxes
		let options: {value: string; label: string}[] = [];

		if ('items' in field) {
			const items = field.items;
			if ('enum' in items && items.enum) {
				options = items.enum.map(v => ({value: v, label: v}));
			} else if ('anyOf' in items) {
				options = (items.anyOf as {const: string; title: string}[]).map(o => ({value: o.const, label: o.title}));
			}
		}

		const defaults = new Set(field.default ?? []);
		const selected = new Set<string>(defaults);
		this.fieldValues.set(key, [...selected]);

		const list = parent.createDiv({cls: 'synapse-elicitation-checklist'});
		for (const opt of options) {
			const row = list.createDiv({cls: 'synapse-elicitation-check-row'});
			const cb = row.createEl('input', {type: 'checkbox'});
			cb.checked = defaults.has(opt.value);
			row.createEl('span', {text: opt.label});
			cb.addEventListener('change', () => {
				if (cb.checked) selected.add(opt.value);
				else selected.delete(opt.value);
				this.fieldValues.set(key, [...selected]);
			});
		}
	}

	private renderSelectField(parent: HTMLElement, key: string, values: string[], labels?: string[], defaultValue?: string): void {
		const select = parent.createEl('select', {cls: 'dropdown synapse-elicitation-select'});

		// Empty placeholder option
		const emptyOpt = select.createEl('option', {text: 'Select an option', value: ''});
		emptyOpt.disabled = true;
		if (!defaultValue) emptyOpt.selected = true;

		for (let i = 0; i < values.length; i++) {
			const opt = select.createEl('option', {
				text: labels?.[i] ?? values[i]!,
				value: values[i]!,
			});
			if (defaultValue === values[i]) {
				opt.selected = true;
				this.fieldValues.set(key, values[i]!);
			}
		}

		select.addEventListener('change', () => {
			this.fieldValues.set(key, select.value);
		});
	}
}
