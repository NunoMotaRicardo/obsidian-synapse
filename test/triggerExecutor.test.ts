import {describe, it, expect, vi, beforeEach} from 'vitest';
import type {App} from 'obsidian';
import type {TriggerConfig} from '../src/types';
import type SynapsePlugin from '../src/main';
import type {AgentService} from '../src/agentService';
import {createMockApp, seedFile, seedFolder, readVaultFile} from './setup';

// executeLocalProviderQuery would otherwise make a real HTTP call — mock the
// module, keeping every other export (types only, erased at runtime) real.
vi.mock('../src/providerModels', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/providerModels')>();
	return {...actual, executeLocalProviderQuery: vi.fn()};
});

import {executeTrigger} from '../src/triggerExecutor';
import {executeLocalProviderQuery} from '../src/providerModels';
import {lockManager, LockAcquisitionError} from '../src/lockManager';
import {parseFrontmatter} from '../src/configWriter';

const mockedExecuteLocalProviderQuery = executeLocalProviderQuery as ReturnType<typeof vi.fn>;

type InlineChatOptions = Parameters<AgentService['inlineChat']>[0];
type InlineChatResult = Awaited<ReturnType<AgentService['inlineChat']>>;
type InlineChatImpl = (options: InlineChatOptions) => Promise<InlineChatResult>;

// ---------------------------------------------------------------------------
// Fake plugin harness
// ---------------------------------------------------------------------------

function makeTrigger(overrides: Partial<TriggerConfig> = {}): TriggerConfig {
	return {
		name: 'test-trigger',
		description: 'a test trigger',
		event: 'file-created',
		body: 'Do the thing for {{file}}.',
		write: false,
		enabled: true,
		filePath: '_synapse/triggers/test-trigger.md',
		...overrides,
	};
}

function makePlugin(inlineChatImpl?: InlineChatImpl) {
	const app = createMockApp() as unknown as App;
	// appendToReport/ensureReportsFolder needs `_synapse` to already exist —
	// `createFolder` (mirroring real Obsidian) requires the immediate parent
	// to exist already, matching `ensureFolder`'s segment-by-segment walk.
	seedFolder(app, '_synapse');

	const inlineChat = vi.fn(inlineChatImpl ?? (async () => ({content: 'claude result', sessionId: 'session-1'})));
	const plugin = {
		app,
		settings: {triggerLastFired: {} as Record<string, number>},
		saveSettings: vi.fn(async () => {}),
		agentService: {
			isLocalModel: vi.fn(() => false),
			getProviderConfig: vi.fn(() => ({baseUrl: 'http://localhost:1234'})),
			getModels: vi.fn(() => []),
			inlineChat,
		},
	};
	return {app, plugin, inlineChat};
}

/** Cast the fake plugin fixture (a deliberately partial `SynapsePlugin`) for passing into `executeTrigger`. */
function asPlugin(plugin: ReturnType<typeof makePlugin>['plugin']): SynapsePlugin {
	return plugin as unknown as SynapsePlugin;
}

async function readReport(app: App, triggerName: string): Promise<string> {
	const today = new Date();
	const y = today.getFullYear();
	const m = String(today.getMonth() + 1).padStart(2, '0');
	const d = String(today.getDate()).padStart(2, '0');
	return readVaultFile(app, `_synapse/reports/${triggerName}-${y}-${m}-${d}.md`);
}

beforeEach(() => {
	mockedExecuteLocalProviderQuery.mockReset();
});

// ---------------------------------------------------------------------------
// Default write mode (false) — append to report
// ---------------------------------------------------------------------------

describe('executeTrigger — write: false (default, append to report)', () => {
	it('appends the Claude result to the daily report file', async () => {
		const {app, plugin} = makePlugin(async () => ({content: 'Result content', sessionId: 's1'}));
		const trigger = makeTrigger({write: false});

		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');

		const raw = await readReport(app, trigger.name);
		expect(raw).toContain('Result content');
		expect(raw).toContain(`# ${trigger.name} —`);
	});

	it('appends a second run below the first, separated by a blank line, without overwriting', async () => {
		const {app, plugin} = makePlugin();
		const trigger = makeTrigger({write: false});

		plugin.agentService.inlineChat = vi.fn()
			.mockResolvedValueOnce({content: 'first run', sessionId: 's1'})
			.mockResolvedValueOnce({content: 'second run', sessionId: 's2'});

		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');
		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');

		const raw = await readReport(app, trigger.name);
		expect(raw).toContain('first run');
		expect(raw).toContain('second run');
	});

	it('records triggerLastFired and calls saveSettings even on success', async () => {
		const {plugin} = makePlugin();
		const trigger = makeTrigger({write: false});

		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');

		expect(plugin.settings.triggerLastFired[trigger.name]).toBeTypeOf('number');
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
	});

	it('substitutes {{file}} in the prompt body before sending to the model', async () => {
		const {plugin, inlineChat} = makePlugin();
		const trigger = makeTrigger({write: false, body: 'Look at {{file}} please.'});

		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');

		expect(inlineChat).toHaveBeenCalledWith(expect.objectContaining({
			prompt: 'Look at notes/target.md please.',
		}));
	});

	it('catches a model error, appends it to the report under an Error heading, and still records triggerLastFired', async () => {
		const {app, plugin} = makePlugin(async () => {
			throw new Error('model exploded');
		});
		const trigger = makeTrigger({write: false});

		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');

		const raw = await readReport(app, trigger.name);
		expect(raw).toContain('## Error');
		expect(raw).toContain('model exploded');
		expect(plugin.settings.triggerLastFired[trigger.name]).toBeTypeOf('number');
	});
});

// ---------------------------------------------------------------------------
// write: true — full file replace + empty-response guard
// ---------------------------------------------------------------------------

describe('executeTrigger — write: true (full file replace)', () => {
	it('replaces the triggering file content with the model result', async () => {
		const {app, plugin} = makePlugin(async () => ({content: 'New file content', sessionId: 's1'}));
		seedFile(app, 'notes/target.md', 'Old content');
		const trigger = makeTrigger({write: true});

		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');

		expect(await readVaultFile(app, 'notes/target.md')).toBe('New file content');
	});

	it('skips the write and appends "(empty response — write skipped)" to the report when the model returns empty content', async () => {
		const {app, plugin} = makePlugin(async () => ({content: '', sessionId: 's1'}));
		seedFile(app, 'notes/target.md', 'Untouched content');
		const trigger = makeTrigger({write: true});

		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');

		expect(await readVaultFile(app, 'notes/target.md')).toBe('Untouched content');

		const report = await readReport(app, trigger.name);
		expect(report).toContain('(empty response — write skipped)');
	});

	it('falls back to appending to the report when the target file does not exist', async () => {
		const {app, plugin} = makePlugin(async () => ({content: 'Some result', sessionId: 's1'}));
		const trigger = makeTrigger({write: true});

		// notes/missing.md was never seeded — file not found.
		await executeTrigger(asPlugin(plugin), trigger, 'notes/missing.md');

		const report = await readReport(app, trigger.name);
		expect(report).toContain('Some result');
	});

	it('falls back to appending to the report when acquiring the write-back lock times out', async () => {
		const {app, plugin} = makePlugin(async () => ({content: 'Lock-contended result', sessionId: 's1'}));
		seedFile(app, 'notes/target.md', 'Original');
		const trigger = makeTrigger({write: true});

		const spy = vi.spyOn(lockManager, 'withLock').mockRejectedValueOnce(
			new LockAcquisitionError('notes/target.md'),
		);

		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');
		spy.mockRestore();

		// File untouched (write-back never happened)...
		expect(await readVaultFile(app, 'notes/target.md')).toBe('Original');
		// ...and the result was appended to the report instead.
		const report = await readReport(app, trigger.name);
		expect(report).toContain('Lock-contended result');
	});
});

// ---------------------------------------------------------------------------
// write: 'frontmatter' — merge response into frontmatter
// ---------------------------------------------------------------------------

describe("executeTrigger — write: 'frontmatter'", () => {
	it('parses the model response as frontmatter fields and merges them into the file', async () => {
		const {app, plugin} = makePlugin(async () => ({content: 'status: done\npriority: high', sessionId: 's1'}));
		seedFile(app, 'notes/target.md', '---\nstatus: pending\n---\nBody text');
		const trigger = makeTrigger({write: 'frontmatter'});

		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');

		const raw = await readVaultFile(app, 'notes/target.md');
		const {meta, body} = parseFrontmatter(raw);
		expect(meta['status']).toBe('done');
		expect(meta['priority']).toBe('high');
		expect(body.trim()).toBe('Body text');
	});

	it('falls back to appending to the report when the target file does not exist', async () => {
		const {app, plugin} = makePlugin(async () => ({content: 'status: done', sessionId: 's1'}));
		const trigger = makeTrigger({write: 'frontmatter'});

		await executeTrigger(asPlugin(plugin), trigger, 'notes/missing.md');

		const report = await readReport(app, trigger.name);
		expect(report).toContain('status: done');
	});

	it('falls back to appending to the report when acquiring the frontmatter-merge lock times out', async () => {
		const {app, plugin} = makePlugin(async () => ({content: 'status: done', sessionId: 's1'}));
		seedFile(app, 'notes/target.md', '---\nstatus: pending\n---\nBody');
		const trigger = makeTrigger({write: 'frontmatter'});

		const spy = vi.spyOn(lockManager, 'withLock').mockRejectedValueOnce(
			new LockAcquisitionError('notes/target.md'),
		);

		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');
		spy.mockRestore();

		const raw = await readVaultFile(app, 'notes/target.md');
		const {meta} = parseFrontmatter(raw);
		// Frontmatter untouched (merge never happened)...
		expect(meta['status']).toBe('pending');
		// ...and the raw result was appended to the report instead.
		const report = await readReport(app, trigger.name);
		expect(report).toContain('status: done');
	});
});

// ---------------------------------------------------------------------------
// Local-model routing
// ---------------------------------------------------------------------------

describe('executeTrigger — local model routing', () => {
	it('routes through executeLocalProviderQuery when trigger.model is a known local model', async () => {
		const {app, plugin, inlineChat} = makePlugin();
		plugin.agentService.isLocalModel = vi.fn(() => true);
		mockedExecuteLocalProviderQuery.mockResolvedValue({ok: true, content: 'Local model result'});

		const trigger = makeTrigger({write: false, model: 'qwen3:8b'});
		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');

		expect(mockedExecuteLocalProviderQuery).toHaveBeenCalledTimes(1);
		expect(inlineChat).not.toHaveBeenCalled();
		const report = await readReport(app, trigger.name);
		expect(report).toContain('Local model result');
	});

	it('surfaces a local provider error as a report entry under an Error heading', async () => {
		const {app, plugin} = makePlugin();
		plugin.agentService.isLocalModel = vi.fn(() => true);
		mockedExecuteLocalProviderQuery.mockResolvedValue({ok: false, error: 'connection refused'});

		const trigger = makeTrigger({write: false, model: 'qwen3:8b'});
		await executeTrigger(asPlugin(plugin), trigger, 'notes/target.md');

		const report = await readReport(app, trigger.name);
		expect(report).toContain('## Error');
		expect(report).toContain('connection refused');
	});
});
