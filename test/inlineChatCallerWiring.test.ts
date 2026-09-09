import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {autoApproveReadOnlyTools} from '../src/agentService';

// ---------------------------------------------------------------------------
// Issue #167 — wiring `autoApproveReadOnlyTools` (agentService.ts) into the
// two searchPanel.ts inlineChat() call sites that genuinely request tools
// (`tools: ['Read', 'Glob', 'Grep']`, maxTurns: 40), so their tool calls
// never hit an approval modal in an unattended one-shot search.
//
// Post-#220 the local-model branch this test file's third describe block used
// to exercise (the OpenAI-compatible `/v1/chat/completions` loop with vault
// tools) is gone: local models run through the real Agent SDK/CLI via the
// local agent endpoint (issue #122), so the auto-approve handler is now only
// ever exercised on the SDK path — these tests keep verifying the handler's
// own allow/deny semantics and the wiring of its callers.
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

	it.each(['Read', 'Glob', 'Grep'])(
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
		// for the vault settings layer). Post-#220 there is no local-model branch left to gate:
		// local models run through the Agent SDK via the local agent endpoint (issue #122),
		// and none of these sites set `canUseTool`, so no auto-approval is wired here either —
		// the #167 guarantee (no vault tools offered here) still holds.
		expect(source).not.toContain('canUseTool: autoApproveReadOnlyTools');
	});
});
