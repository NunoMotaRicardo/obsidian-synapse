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
			// `app: this.app` (injection era) became `app: this.view.app` under the
			// SearchPanelController composition — same value, controller-relative spelling.
			expect(body).toMatch(/app: this\.(view\.)?app/);
			expect(body).toContain('canUseTool: autoApproveReadOnlyTools');
		}
	});

	it('imports autoApproveReadOnlyTools from the single agent service module (no second adapter)', () => {
		const source = read('src/view/searchPanel.ts');
		expect(source).toMatch(/import\s*\{[^}]*autoApproveReadOnlyTools[^}]*\}\s*from\s*'\.\.\/agentService'/);
	});
});

describe('editorMenu.ts — read-only image sites left unwired, deliberately (#167)', () => {
	it('does not offer vault tools to the two image-reading inlineChat() call sites', () => {
		const source = read('src/editor/editorMenu.ts');
		// The two image-reading call sites (askAboutImage, extractImageContent) request their
		// `Read` tool via the `readOnly` inlineChat() profile now (issue #230); they must not
		// have gained `app`/`canUseTool` — see the module doc comment above for why wiring
		// them would not achieve parity (image bytes never reach the local branch at all).
		const readProfileCallSites = (source.match(/profile: 'readOnly'/g) ?? []).length;
		expect(readProfileCallSites).toBeGreaterThanOrEqual(2);
		expect(source).not.toContain('canUseTool: autoApproveReadOnlyTools');
		expect(source).not.toMatch(/import\s*\{[^}]*autoApproveReadOnlyTools/);
	});

	it('lets no call site override its own profile with a wider tools/maxTurns value (issue #230)', () => {
		// The profile convention is "caller's explicit value wins" — which means a call site
		// could silently defeat its profile's restrictiveness (e.g. `profile: 'textTransform',
		// tools: ['Write']`). This makes the convention self-enforcing instead: every
		// textTransform/readOnly/attended call body in editorMenu.ts + editModal.ts must rely
		// entirely on the profile for its tools/maxTurns shape (deepseek-v4-pro review of #231).
		for (const rel of ['src/editor/editorMenu.ts', 'src/modals/editModal.ts']) {
			const source = read(rel);
			const callBodies = source.split(/inlineChat\(\{/).slice(1)
				.map(call => call.slice(0, call.indexOf('});')));
			for (const body of callBodies) {
				if (!/profile: '(textTransform|readOnly|attended)'/.test(body)) continue;
				expect(body).not.toMatch(/\btools\s*:/);
				expect(body).not.toMatch(/\bmaxTurns\s*:/);
			}
		}
	});

	it('leaves the textTransform (profile) call sites without canUseTool — no vault-tool gating added', () => {
		const source = read('src/editor/editorMenu.ts');
		// The six pure text-transform call sites request no tools at all — expressed via the
		// `textTransform` profile since issue #230 (the old literal `tools: []`/`maxTurns: 1`
		// pairs the convention moved into the interface).
		expect((source.match(/profile: 'textTransform'/g) ?? []).length).toBeGreaterThanOrEqual(6);
		// `app: plugin.app` IS now present on these call sites (issue #194 — every inlineChat()
		// caller passes `app` so AgentService can derive `_synapse/settings.json`'s vault path
		// for the vault settings layer). Post-#220 there is no local-model branch left to gate:
		// local models run through the Agent SDK via the local agent endpoint (issue #122),
		// and none of these sites set `canUseTool`, so no auto-approval is wired here either —
		// the #167 guarantee (no vault tools offered here) still holds.
		expect(source).not.toContain('canUseTool: autoApproveReadOnlyTools');
	});
});
