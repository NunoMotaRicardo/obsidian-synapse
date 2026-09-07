import {describe, it, expect, beforeEach, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {requestUrl} from 'obsidian';
import {AgentService, autoApproveReadOnlyTools} from '../src/agentService';

// ---------------------------------------------------------------------------
// Issue #167 — #150 gave inlineChat() a local-model tool branch, but no
// caller could reach it: none of the 22 inlineChat() call sites passed `app`
// or `canUseTool`, so every one still fell back to the pre-#150 bare
// one-shot on a local model. This issue wires the two call sites that
// genuinely request tools on the SDK path and would visibly benefit
// (searchPanel.ts's basic + advanced search, `tools: ['Read', 'Glob',
// 'Grep']`, maxTurns: 40) with a new auto-approving `canUseTool` —
// `autoApproveReadOnlyTools` (agentService.ts) — rather than the chat
// panel's interactive `ToolApprovalModal` handler, because that would mean
// up to 40 approval modals for one search.
//
// `editorMenu.ts`'s two `tools: ['Read']` sites (askAboutImage,
// extractImageContent) are deliberately left unwired: they use Claude's
// native multimodal Read tool to view an *image* at an absolute OS path.
// `vaultTools`'s `read_note` only resolves vault-relative paths and returns
// `app.vault.read()` as UTF-8 text — it cannot serve as an analogue for
// reading image bytes, and `inlineChat()` has no `images` parameter to give
// the local branch the image data another way (unlike `Session.send()`,
// which does — `src/agentService.ts:1373`). Wiring vaultTools there would
// only add spurious "File not found" tool calls, not fix anything; that gap
// is a separate, larger feature (an `images` parameter on `inlineChat()`),
// out of scope for this issue.
// ---------------------------------------------------------------------------

const repoRoot = resolve(__dirname, '..');

function read(relativePath: string): string {
	return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

describe('autoApproveReadOnlyTools', () => {
	const call = (toolName: string, input: Record<string, unknown> = {}) =>
		autoApproveReadOnlyTools(toolName, input, {
			signal: new AbortController().signal,
			toolUseID: 'test-tool-use-id',
			requestId: 'test-tool-use-id',
		});

	it.each(['read_note', 'list_notes', 'search_notes', 'Read', 'Glob', 'Grep'])(
		'allows the read-only tool %s',
		async toolName => {
			const result = await call(toolName, {path: 'foo.md'});
			expect(result?.behavior).toBe('allow');
		},
	);

	// The handler's safety must not rest on callers restricting `tools` correctly:
	// inlineChat() forwards the same canUseTool to the raw Claude-path query(), so a
	// blanket allow would grant writes to any future call site that wired it in next to
	// a write-capable tool. It fails closed on the tool name instead.
	it.each(['Write', 'Edit', 'Bash', 'NotebookEdit'])(
		'denies %s even though the call site asked for auto-approval',
		async toolName => {
			const result = await call(toolName, {file_path: 'foo.md'});
			expect(result?.behavior).toBe('deny');
		},
	);
});

describe('searchPanel.ts wiring (#167)', () => {
	// This is the wiring gap #167 closes: before this change, neither
	// handleBasicSearch nor handleAdvancedSearch passed `app`/`canUseTool` to
	// inlineChat(), so inlineChat()'s `supportsTools && options.app &&
	// options.canUseTool` gate (agentService.ts) was never satisfied on a
	// local model and the local-model branch never offered vaultTools.
	it('passes app and autoApproveReadOnlyTools alongside the read-only tool set on both search call sites', () => {
		const source = read('src/view/searchPanel.ts');
		const inlineChatCalls = source.split('inlineChat({').slice(1);
		expect(inlineChatCalls.length).toBe(2);
		for (const call of inlineChatCalls) {
			const closeIdx = call.indexOf('});');
			const body = closeIdx === -1 ? call.slice(0, 400) : call.slice(0, closeIdx);
			expect(body).toContain('app: this.app');
			expect(body).toContain('canUseTool: autoApproveReadOnlyTools');
		}
	});

	it('imports autoApproveReadOnlyTools from the single agent service module (no second adapter)', () => {
		const source = read('src/view/searchPanel.ts');
		expect(source).toMatch(/import\s*\{[^}]*autoApproveReadOnlyTools[^}]*\}\s*from\s*'\.\.\/agentService'/);
	});
});

describe('editorMenu.ts — tools: [\'Read\'] sites left unwired, deliberately (#167)', () => {
	it('does not offer vault tools to the two image-reading inlineChat() call sites', () => {
		const source = read('src/editor/editorMenu.ts');
		// Both `tools: ['Read']` call sites (askAboutImage, extractImageContent) must not have
		// gained `app`/`canUseTool` — see the module doc comment above for why wiring them
		// would not achieve parity (image bytes never reach the local branch at all).
		const readToolCallSites = source.split(/\n(?=\t*tools: \['Read'\],)/).filter(s => s.includes("tools: ['Read']"));
		expect(readToolCallSites.length).toBeGreaterThanOrEqual(2);
		expect(source).not.toContain('canUseTool: autoApproveReadOnlyTools');
		expect(source).not.toMatch(/import\s*\{[^}]*autoApproveReadOnlyTools/);
	});

	it('leaves the toolless (tools: []) call sites without canUseTool — no vault-tool gating added', () => {
		const source = read('src/editor/editorMenu.ts');
		expect((source.match(/tools: \[\]/g) ?? []).length).toBeGreaterThanOrEqual(6);
		// `app: plugin.app` IS now present on these call sites (issue #194 — every inlineChat()
		// caller passes `app` so AgentService can derive `_synapse/settings.json`'s vault path
		// for the vault settings layer), but that alone does not reach the local-model branch's
		// `localTools` gate (agentService.ts: `supportsTools && options.app && options.canUseTool`)
		// without `canUseTool`, which none of these sites set — so the #167 guarantee (no vault
		// tools offered here) still holds.
		expect(source).not.toContain('canUseTool: autoApproveReadOnlyTools');
	});
});

describe('AgentService#inlineChat — autoApproveReadOnlyTools end to end on the local-model branch', () => {
	const mockedRequestUrl = vi.mocked(requestUrl);

	function jsonResponse(status: number, body: unknown) {
		return {status, json: body, text: JSON.stringify(body), arrayBuffer: new ArrayBuffer(0), headers: {}};
	}

	function makeService(): AgentService {
		return new AgentService({
			providerConfig: {preset: 'openai', baseUrl: 'http://localhost:9999'},
			claudeLocation: process.execPath,
		});
	}

	beforeEach(() => {
		mockedRequestUrl.mockReset();
	});

	it('reaches and executes a vault tool with no per-call gating (a single canUseTool wired once, not per tool call)', async () => {
		const service = makeService();
		service.setCustomModels([{id: 'tool-model', name: 'Tool Model'}]);

		let call = 0;
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string};
			if (req.url.endsWith('/v1/chat/completions')) {
				call++;
				if (call === 1) {
					return Promise.resolve(jsonResponse(200, {
						choices: [{
							message: {
								role: 'assistant',
								content: '',
								tool_calls: [{id: 'call_1', type: 'function', function: {name: 'list_notes', arguments: '{}'}}],
							},
						}],
					}));
				}
				return Promise.resolve(jsonResponse(200, {choices: [{message: {role: 'assistant', content: '[]'}}]}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);

		const getFiles = vi.fn().mockReturnValue([]);
		const result = await service.inlineChat({
			prompt: 'search the vault',
			model: 'tool-model',
			tools: ['Read', 'Glob', 'Grep'],
			maxTurns: 40,
			app: {vault: {getFiles}} as never,
			canUseTool: autoApproveReadOnlyTools,
		});

		expect(result.content).toBe('[]');
		// The vault tool actually ran — proving the local branch was reached and the
		// auto-approve handler let it through without a modal/gate blocking it.
		expect(getFiles).toHaveBeenCalledTimes(1);
	});

	it('still fails closed (no tools) when supportsTools: false, even with app + autoApproveReadOnlyTools supplied', async () => {
		const service = makeService();
		service.setCustomModels([{id: 'no-tools-model', name: 'No Tools Model', supportsTools: false}]);
		mockedRequestUrl.mockImplementation(((request: unknown) => {
			const req = request as {url: string};
			if (req.url.endsWith('/v1/chat/completions')) {
				return Promise.resolve(jsonResponse(200, {choices: [{message: {role: 'assistant', content: 'no tools used'}}]}));
			}
			return Promise.resolve(jsonResponse(404, {}));
		}) as typeof requestUrl);

		const getFiles = vi.fn().mockReturnValue([]);
		const result = await service.inlineChat({
			prompt: 'search the vault',
			model: 'no-tools-model',
			tools: ['Read', 'Glob', 'Grep'],
			maxTurns: 40,
			app: {vault: {getFiles}} as never,
			canUseTool: autoApproveReadOnlyTools,
		});

		expect(result.content).toBe('no tools used');
		expect(getFiles).not.toHaveBeenCalled();
		const call = mockedRequestUrl.mock.calls.find(([opts]) => (opts as {url: string}).url.endsWith('/v1/chat/completions'));
		const body = JSON.parse((call?.[0] as {body?: string})?.body || '{}') as {tools?: unknown};
		expect(body.tools).toBeUndefined();
	});
});
