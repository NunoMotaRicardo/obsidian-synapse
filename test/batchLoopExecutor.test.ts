import {describe, it, expect, vi} from 'vitest';
import type {App} from 'obsidian';
import type SynapsePlugin from '../src/main';
import type {AgentService, SDKMessage} from '../src/agentService';
import {createMockApp, seedFile, seedFolder, readVaultFile} from './setup';
import {
	resolveScopeToFiles,
	runBatchLoop,
	BatchLoopHandle,
	BATCH_LOOP_MAX_FILES,
	parseBudgetInput,
} from '../src/batchLoopExecutor';

type InlineChatOptions = Parameters<AgentService['inlineChat']>[0];
type InlineChatResult = Awaited<ReturnType<AgentService['inlineChat']>>;
type InlineChatImpl = (options: InlineChatOptions) => Promise<InlineChatResult>;

// ---------------------------------------------------------------------------
// resolveScopeToFiles — scope resolution
// ---------------------------------------------------------------------------

describe('resolveScopeToFiles', () => {
	function seedVault(app: App) {
		seedFile(app, 'root.md', '');
		seedFolder(app, 'projects');
		seedFile(app, 'projects/a.md', '');
		seedFile(app, 'projects/b.md', '');
		seedFolder(app, 'projects/nested');
		seedFile(app, 'projects/nested/c.md', '');
		seedFile(app, 'projects/notes.png', ''); // non-markdown, must be excluded
		seedFolder(app, '_synapse');
		seedFolder(app, '_synapse/reports');
		seedFile(app, '_synapse/reports/batch-loop-2026-01-01.md', '');
	}

	it('expands a folder recursively into its markdown files', () => {
		const app = createMockApp() as unknown as App;
		seedVault(app);

		const result = resolveScopeToFiles(app, ['projects']);

		expect(result).toEqual(['projects/a.md', 'projects/b.md', 'projects/nested/c.md']);
	});

	it('includes a directly-selected file as-is', () => {
		const app = createMockApp() as unknown as App;
		seedVault(app);

		const result = resolveScopeToFiles(app, ['root.md']);

		expect(result).toEqual(['root.md']);
	});

	it('excludes non-markdown files', () => {
		const app = createMockApp() as unknown as App;
		seedVault(app);

		const result = resolveScopeToFiles(app, ['projects']);

		expect(result).not.toContain('projects/notes.png');
	});

	it('excludes the _synapse folder even when scope is the whole vault ("/")', () => {
		const app = createMockApp() as unknown as App;
		seedVault(app);

		const result = resolveScopeToFiles(app, ['/']);

		expect(result.some(p => p.startsWith('_synapse'))).toBe(false);
		expect(result).toContain('root.md');
		expect(result).toContain('projects/a.md');
	});

	it('de-duplicates and sorts overlapping selections', () => {
		const app = createMockApp() as unknown as App;
		seedVault(app);

		const result = resolveScopeToFiles(app, ['projects', 'projects/a.md']);

		expect(result).toEqual(['projects/a.md', 'projects/b.md', 'projects/nested/c.md']);
	});

	it('returns [] for a path that does not resolve to a file or folder', () => {
		const app = createMockApp() as unknown as App;
		seedVault(app);

		expect(resolveScopeToFiles(app, ['does/not/exist'])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Fake plugin harness for runBatchLoop
// ---------------------------------------------------------------------------

function resultMessage(overrides: {inputTokens?: number; outputTokens?: number; costUsd?: number} = {}) {
	return {
		type: 'result',
		usage: {
			input_tokens: overrides.inputTokens ?? 100,
			output_tokens: overrides.outputTokens ?? 50,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
		total_cost_usd: overrides.costUsd ?? 0.01,
	};
}

function makePlugin(inlineChatImpl: InlineChatImpl, toolApproval: 'ask' | 'allow' = 'ask') {
	const app = createMockApp() as unknown as App;
	seedFolder(app, '_synapse');

	const inlineChat = vi.fn(inlineChatImpl);
	const plugin = {
		app,
		settings: {toolApproval},
		agentService: {inlineChat},
	};
	return {app, plugin, inlineChat};
}

/** Cast the fake plugin fixture (a deliberately partial `SynapsePlugin`) for passing into `runBatchLoop`. */
function asPlugin(plugin: ReturnType<typeof makePlugin>['plugin']): SynapsePlugin {
	return plugin as unknown as SynapsePlugin;
}

async function readTodaysReport(app: App): Promise<string> {
	const today = new Date();
	const y = today.getFullYear();
	const m = String(today.getMonth() + 1).padStart(2, '0');
	const d = String(today.getDate()).padStart(2, '0');
	return readVaultFile(app, `_synapse/reports/batch-loop-${y}-${m}-${d}.md`);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runBatchLoop — happy path', () => {
	it('processes every file, substitutes {{file}}, and reports success', async () => {
		const {app, plugin, inlineChat} = makePlugin(async (opts) => ({content: `handled ${opts.prompt}`, sessionId: 's1'}));
		const handle = new BatchLoopHandle();

		const result = await runBatchLoop(asPlugin(plugin), ['a.md', 'b.md'], 'process {{file}}', handle);

		expect(result).toEqual({processed: 2, failed: 0, skipped: 0, cancelled: false, reason: 'completed'});
		expect(inlineChat).toHaveBeenCalledTimes(2);
		expect(inlineChat).toHaveBeenNthCalledWith(1, expect.objectContaining({prompt: 'process a.md'}));
		expect(inlineChat).toHaveBeenNthCalledWith(2, expect.objectContaining({prompt: 'process b.md'}));

		const report = await readTodaysReport(app);
		expect(report).toContain('## a.md');
		expect(report).toContain('## b.md');
		expect(report).toContain('handled process a.md');
	});

	it('reports a per-file error under an Error heading and continues processing the rest', async () => {
		const {app, plugin} = makePlugin(async (opts) => {
			if (opts.prompt.includes('bad.md')) throw new Error('boom');
			return {content: 'ok', sessionId: 's1'};
		});
		const handle = new BatchLoopHandle();

		const result = await runBatchLoop(asPlugin(plugin), ['bad.md', 'good.md'], '{{file}}', handle);

		expect(result.processed).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.reason).toBe('completed');

		const report = await readTodaysReport(app);
		expect(report).toContain('## bad.md');
		expect(report).toContain('### Error');
		expect(report).toContain('boom');
		expect(report).toContain('## good.md');
	});
});

// ---------------------------------------------------------------------------
// Scope-too-large guard
// ---------------------------------------------------------------------------

describe('runBatchLoop — scope-too-large guard', () => {
	it('refuses to start and reports the overage when scope exceeds BATCH_LOOP_MAX_FILES', async () => {
		const {plugin, inlineChat} = makePlugin(async () => ({content: 'ok', sessionId: 's1'}));
		const handle = new BatchLoopHandle();
		const files = Array.from({length: BATCH_LOOP_MAX_FILES + 5}, (_, i) => `file-${i}.md`);

		const result = await runBatchLoop(asPlugin(plugin), files, 'do it', handle);

		expect(result.reason).toBe('scope-too-large');
		expect(result.processed).toBe(0);
		expect(result.skipped).toBe(5);
		expect(inlineChat).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

describe('runBatchLoop — budget enforcement', () => {
	it('stops before starting a file once cumulative token usage meets the budget', async () => {
		const {app, plugin, inlineChat} = makePlugin(async (opts) => {
			opts.onEvent?.(resultMessage({inputTokens: 80, outputTokens: 20}) as unknown as SDKMessage); // 100 tokens/file
			return {content: 'ok', sessionId: 's1'};
		});
		const handle = new BatchLoopHandle();

		const result = await runBatchLoop(
			asPlugin(plugin),
			['a.md', 'b.md', 'c.md'],
			'{{file}}',
			handle,
			undefined,
			{type: 'tokens', max: 100},
		);

		// Budget is checked *before* each file starts (never cuts a file off
		// mid-flight): file 1 runs (usage 0 < 100 going in), pushes usage to
		// 100, then the pre-file check for file 2 sees usage >= 100 and stops.
		expect(inlineChat).toHaveBeenCalledTimes(1);
		expect(result.processed).toBe(1);
		expect(result.reason).toBe('budget-exceeded');
		expect(result.skipped).toBe(2);

		const report = await readTodaysReport(app);
		expect(report).toContain('### Run summary');
		expect(report).toContain('budget exhausted');
	});

	it('stops once cumulative dollar spend meets a dollar budget', async () => {
		const {plugin, inlineChat} = makePlugin(async (opts) => {
			opts.onEvent?.(resultMessage({costUsd: 3}) as unknown as SDKMessage);
			return {content: 'ok', sessionId: 's1'};
		});
		const handle = new BatchLoopHandle();

		const result = await runBatchLoop(
			asPlugin(plugin),
			['a.md', 'b.md'],
			'{{file}}',
			handle,
			undefined,
			{type: 'dollars', max: 2},
		);

		expect(inlineChat).toHaveBeenCalledTimes(1);
		expect(result.reason).toBe('budget-exceeded');
	});

	it('does not enforce a budget when none is passed (unlimited, matches original behavior)', async () => {
		const {plugin, inlineChat} = makePlugin(async (opts) => {
			opts.onEvent?.(resultMessage({inputTokens: 1_000_000}) as unknown as SDKMessage);
			return {content: 'ok', sessionId: 's1'};
		});
		const handle = new BatchLoopHandle();

		const result = await runBatchLoop(asPlugin(plugin), ['a.md', 'b.md'], '{{file}}', handle);

		expect(inlineChat).toHaveBeenCalledTimes(2);
		expect(result.reason).toBe('completed');
	});

	it('reports cumulative usage via onProgress with "starting" (pre-file) and "done" (post-file) phases', async () => {
		const {plugin} = makePlugin(async (opts) => {
			opts.onEvent?.(resultMessage({inputTokens: 40, outputTokens: 10}) as unknown as SDKMessage);
			return {content: 'ok', sessionId: 's1'};
		});
		const handle = new BatchLoopHandle();
		const calls: Array<{phase: string; totalTokens: number}> = [];

		await runBatchLoop(asPlugin(plugin), ['a.md'], '{{file}}', handle, (progress, usage) => {
			calls.push({phase: progress.phase, totalTokens: usage.totalTokens});
		});

		expect(calls).toEqual([
			{phase: 'starting', totalTokens: 0},
			{phase: 'done', totalTokens: 50},
		]);
	});
});

// ---------------------------------------------------------------------------
// parseBudgetInput re-export sanity (used by the launch flow's prompt loop)
// ---------------------------------------------------------------------------

describe('parseBudgetInput (re-exported from budget.ts)', () => {
	it('parses a bare number as a token budget', () => {
		expect(parseBudgetInput('500000')).toEqual({type: 'tokens', max: 500000});
	});

	it('parses a dollar amount', () => {
		expect(parseBudgetInput('$5')).toEqual({type: 'dollars', max: 5});
	});

	it('treats empty/"none" as no budget', () => {
		expect(parseBudgetInput('')).toBeUndefined();
		expect(parseBudgetInput('none')).toBeUndefined();
	});

	it('returns null for unparseable input', () => {
		expect(parseBudgetInput('banana')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('runBatchLoop — cancellation', () => {
	it('stops between files when handle.stop() is called, and reports the cancellation', async () => {
		const handle = new BatchLoopHandle();
		const {app, plugin, inlineChat} = makePlugin(async (opts) => {
			if (opts.prompt === 'a.md') {
				handle.stop(); // simulate a "Stop" click while file 1 is in flight
			}
			return {content: 'ok', sessionId: 's1'};
		});

		const result = await runBatchLoop(asPlugin(plugin), ['a.md', 'b.md', 'c.md'], '{{file}}', handle);

		// File 1 completes normally (cancellation is checked *between* files);
		// the top-of-loop check before file 2 sees `cancelled` and stops.
		expect(inlineChat).toHaveBeenCalledTimes(1);
		expect(result).toEqual({processed: 1, failed: 0, skipped: 2, cancelled: true, reason: 'cancelled'});

		const report = await readTodaysReport(app);
		expect(report).toContain('### Run summary');
		expect(report).toContain('stopped by user');
	});

	it('treats an abort of the in-flight file (via handle.stop()) as a cancellation, not a per-file failure', async () => {
		const handle = new BatchLoopHandle();
		const {plugin, inlineChat} = makePlugin(async () => {
			handle.stop(); // stop() aborts the active controller and sets cancelled
			throw new Error('aborted'); // simulates inlineChat rejecting once its AbortController fires
		});

		const result = await runBatchLoop(asPlugin(plugin), ['a.md', 'b.md'], '{{file}}', handle);

		expect(inlineChat).toHaveBeenCalledTimes(1);
		expect(result.cancelled).toBe(true);
		expect(result.reason).toBe('cancelled');
		expect(result.failed).toBe(0); // not counted as a failure — it's a cancellation
	});

	it('handle.stop() aborts the AbortController passed to the in-flight inlineChat call', async () => {
		let capturedController: AbortController | undefined;
		const handle = new BatchLoopHandle();
		const {plugin} = makePlugin(async (opts) => {
			capturedController = opts.abortController;
			handle.stop();
			return {content: 'ok', sessionId: 's1'};
		});

		await runBatchLoop(asPlugin(plugin), ['a.md'], '{{file}}', handle);

		expect(capturedController?.signal.aborted).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tool approval policy (issue #151)
// ---------------------------------------------------------------------------

describe('runBatchLoop — unattended tool approval policy (#151)', () => {
	/**
	 * Stand-in for a Claude turn that attempts one tool call (`Write`) via
	 * `inlineChat`'s `canUseTool`, mirroring what the real SDK does — see the
	 * matching helper in `test/triggerExecutor.test.ts`.
	 */
	function makeToolCallingInlineChat(calls: InlineChatOptions[]): InlineChatImpl {
		return async (options) => {
			calls.push(options);
			if (options.canUseTool) {
				const decision = await options.canUseTool('Write', {file_path: 'a.md'}, {
					signal: new AbortController().signal,
					toolUseID: 'tool-1',
					requestId: 'tool-1',
				});
				if (decision?.behavior === 'deny') {
					return {content: 'I was not able to write the file.', sessionId: 's1'};
				}
			}
			return {content: 'Wrote the file successfully.', sessionId: 's1'};
		};
	}

	it('ask mode (default): a refused tool call is logged into the report for that file', async () => {
		const calls: InlineChatOptions[] = [];
		const {app, plugin} = makePlugin(makeToolCallingInlineChat(calls), 'ask');

		await runBatchLoop(asPlugin(plugin), ['a.md'], '{{file}}', new BatchLoopHandle());

		expect(calls[0]?.permissionMode).toBe('default');
		expect(calls[0]?.canUseTool).toBeTypeOf('function');

		const report = await readTodaysReport(app);
		expect(report).toContain('Tool approval');
		expect(report).toContain('Write');
		expect(report).toContain('denied');
	});

	it('allow mode: no tool call is refused, and the report contains no refusal note', async () => {
		const calls: InlineChatOptions[] = [];
		const {app, plugin} = makePlugin(makeToolCallingInlineChat(calls), 'allow');

		await runBatchLoop(asPlugin(plugin), ['a.md'], '{{file}}', new BatchLoopHandle());

		expect(calls[0]?.permissionMode).toBe('bypassPermissions');
		expect(calls[0]?.allowDangerouslySkipPermissions).toBe(true);
		expect(calls[0]?.canUseTool).toBeUndefined();

		const report = await readTodaysReport(app);
		expect(report).toContain('Wrote the file successfully.');
		expect(report).not.toContain('Tool approval');
	});
});
