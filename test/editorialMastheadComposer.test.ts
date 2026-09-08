import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const repoRoot = resolve(__dirname, '..');

describe('editorial restyle: masthead & composer (#208)', () => {
	const stylesPath = resolve(repoRoot, 'styles.css');
	const stylesContent = readFileSync(stylesPath, 'utf8');
	const synapseViewPath = resolve(repoRoot, 'src/synapseView.ts');
	const synapseViewSource = readFileSync(synapseViewPath, 'utf8');
	const inputAreaPath = resolve(repoRoot, 'src/view/inputArea.ts');
	const inputAreaSource = readFileSync(inputAreaPath, 'utf8');
	const specPath = resolve(repoRoot, '.docs/specs/chat-view.md');
	const specContent = readFileSync(specPath, 'utf8');

	describe('AC-1 & AC-2: Masthead', () => {
		it('replaces tab bar with .synapse-masthead in styles.css and synapseView.ts', () => {
			expect(synapseViewSource).toContain('synapse-masthead');
			expect(synapseViewSource).toContain("synapse-masthead-wordmark', text: 'Synapse'");
			expect(synapseViewSource).toContain('synapse-rule-dot');
			expect(synapseViewSource).toContain('synapse-masthead-kicker');
			expect(synapseViewSource).toContain('synapse-masthead-spacer');
			expect(synapseViewSource).toContain('synapse-masthead-tab');
		});

		it('styles masthead wordmark in serif with -0.01em letterspacing', () => {
			expect(stylesContent).toMatch(
				/\.synapse-masthead-wordmark\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-masthead-wordmark\s*\{[^}]*font-size:\s*19px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-masthead-wordmark\s*\{[^}]*letter-spacing:\s*-0\.01em/
			);
		});

		it('styles accent dot as 5px circular block in interactive accent', () => {
			expect(stylesContent).toMatch(
				/\.synapse-masthead\s+\.synapse-rule-dot\s*\{[^}]*width:\s*5px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-masthead\s+\.synapse-rule-dot\s*\{[^}]*height:\s*5px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-masthead\s+\.synapse-rule-dot\s*\{[^}]*background:\s*var\(--interactive-accent\)/
			);
		});

		it('styles kicker in uppercase letterspaced faint text', () => {
			expect(stylesContent).toMatch(
				/\.synapse-masthead-kicker\s*\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-masthead-kicker\s*\{[^}]*letter-spacing:\s*0\.14em/
			);
			expect(stylesContent).toMatch(
				/\.synapse-masthead-kicker\s*\{[^}]*font-size:\s*10px/
			);
		});

		it('styles text tabs as uppercase letterspaced with active underline', () => {
			expect(stylesContent).toMatch(
				/\.synapse-masthead-tab[^{]*\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-masthead-tab[^{]*\{[^}]*letter-spacing:\s*0\.1em/
			);
			expect(stylesContent).toMatch(
				/\.synapse-masthead-tab\.is-active[^{]*\{[^}]*border-bottom-color:\s*var\(--synapse-rule-heavy\)/
			);
		});

		it('closes masthead with a heavier rule than the transcript hairline', () => {
			expect(stylesContent).toContain('--synapse-rule-heavy: var(--text-normal);');
			expect(stylesContent).toMatch(
				/\.synapse-masthead[^{]*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule-heavy\)/
			);
		});

		it('synapseView.ts provides updateMastheadKicker and updates kicker on tab and session changes', () => {
			expect(synapseViewSource).toContain('updateMastheadKicker(text?: string): void');
			expect(synapseViewSource).toContain('this.updateMastheadKicker();');
		});
	});

	describe('AC-3: Composer footer opening and no-card styling', () => {
		it('composer is opened by a heavy rule at .synapse-bottom', () => {
			expect(stylesContent).toMatch(
				/\.synapse-bottom\s*\{[^}]*border-top:\s*1px solid var\(--synapse-rule-heavy\)/
			);
		});

		it('.synapse-input-area is not a card: no border-radius, no box-shadow, transparent background', () => {
			expect(stylesContent).toMatch(
				/\.synapse-input-area\s*\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-input-area\s*\{[^}]*border-radius:\s*0/
			);
			expect(stylesContent).toMatch(
				/\.synapse-input-area\s*\{[^}]*border:\s*none/
			);
			expect(stylesContent).toMatch(
				/\.synapse-input-area\s*\{[^}]*box-shadow:\s*none/
			);
		});
	});

	describe('AC-4: State line', () => {
		it('defines .synapse-state-line above input in uppercase letterspaced layout', () => {
			expect(stylesContent).toMatch(
				/\.synapse-state-line\s*\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-state-line\s*\{[^}]*letter-spacing:\s*0\.13em/
			);
			expect(stylesContent).toMatch(
				/\.synapse-state-line\s*\{[^}]*font-size:\s*10px/
			);
		});

		it('styles active note in the accent color', () => {
			expect(stylesContent).toMatch(
				/\.synapse-state-note\s*\{[^}]*color:\s*var\(--interactive-accent\)/
			);
		});

		it('inputArea.ts implements updateStateLine with NOTE / AGENT / MODEL formatting', () => {
			expect(inputAreaSource).toContain('synapse-state-line');
			expect(inputAreaSource).toContain('synapse-state-note');
			expect(inputAreaSource).toContain('synapse-state-sep');
			expect(inputAreaSource).toContain('synapse-state-agent');
			expect(inputAreaSource).toContain('synapse-state-model');
			expect(inputAreaSource).toContain('proto.updateStateLine = function (): void');
		});
	});

	describe('AC-5: Textarea serif and italic placeholder', () => {
		it('sets textarea in bundled serif font and 16px size', () => {
			expect(stylesContent).toMatch(
				/\.synapse-input\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-input\s*\{[^}]*font-size:\s*16px/
			);
		});

		it('styles placeholder in italic with faint text color', () => {
			expect(stylesContent).toMatch(
				/\.synapse-input::placeholder\s*\{[^}]*font-style:\s*italic/
			);
			expect(stylesContent).toMatch(
				/\.synapse-input::placeholder\s*\{[^}]*color:\s*var\(--text-faint\)/
			);
		});
	});

	describe('AC-6: Composer actions and send button', () => {
		it('renders actions as uppercase letterspaced text buttons underlined on hover', () => {
			expect(stylesContent).toMatch(
				/\.synapse-f-btn\s*\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-f-btn\s*\{[^}]*letter-spacing:\s*0\.07em/
			);
			expect(stylesContent).toMatch(
				/\.synapse-f-btn:hover\s*\{[^}]*border-bottom-color:\s*var\(--interactive-accent\)/
			);
		});

		it('inputArea.ts builds icon buttons for Scope and Attach only — Paste and Edit were removed to match the design reference', () => {
			expect(inputAreaSource).toContain("'Scope'");
			expect(inputAreaSource).toContain("'Attach'");
			expect(inputAreaSource).not.toContain('synapse-f-btn-clip');
			expect(inputAreaSource).not.toContain('synapse-f-btn-edit');
			expect(inputAreaSource).not.toContain('handleClipboard');
			expect(inputAreaSource).not.toContain('openEditFromChat');
			expect(inputAreaSource).not.toContain('synapse-f-btn-label');
		});

		it('does not duplicate a model picker in the composer footer — the toolbar select is the sole model control (#215 AC-2)', () => {
			expect(inputAreaSource).not.toContain('synapse-f-btn-model');
			expect(inputAreaSource).not.toContain('openModelPickerMenu');
			expect(inputAreaSource).not.toContain('updateModelPickerButton');
			expect(stylesContent).not.toContain('.synapse-f-btn-model');
		});

		it('styles send button as a small 30px square accent block with 2px radius', () => {
			expect(stylesContent).toMatch(
				/\.synapse-send-btn\s*\{[^}]*width:\s*30px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-send-btn\s*\{[^}]*height:\s*30px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-send-btn\s*\{[^}]*border-radius:\s*2px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-send-btn\s*\{[^}]*background:\s*var\(--interactive-accent\)/
			);
		});
	});

	describe('AC-7: Chips language and removability', () => {
		it('styles attachment tags with hairline borders, muted background and 11px text', () => {
			expect(stylesContent).toMatch(
				/\.synapse-attachment-tag\s*\{[^}]*border:\s*1px solid var\(--synapse-rule-soft\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-attachment-tag\s*\{[^}]*border-radius:\s*2px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-attachment-tag\s*\{[^}]*font-size:\s*11px/
			);
		});

		it('active note and selection chips feature a remove button', () => {
			expect(inputAreaSource).toContain('synapse-active-note-tag');
			expect(inputAreaSource).toContain('synapse-attachment-remove');
			expect(inputAreaSource).toContain('this.activeNotePath = null;');
		});
	});

	describe('AC-8: Existing composer behavior preservation', () => {
		it('retains slash-command skill popup bindings and auto-resize', () => {
			expect(inputAreaSource).toContain('updateSkillPopup()');
			expect(inputAreaSource).toContain('handleInputKeydownForSkillPopup');
			expect(inputAreaSource).toContain('handleImagePaste');
			expect(inputAreaSource).toContain('handleFileDrop');
		});

		it('retains send/abort streaming state transitions', () => {
			expect(inputAreaSource).toContain('handleAbort()');
			expect(inputAreaSource).toContain('handleSend()');
		});
	});

	describe('AC-9: Colors strictly from theme variables', () => {
		it('masthead and composer CSS rules use Obsidian CSS variables only without raw hex', () => {
			// Extract masthead through composer section
			const mastheadStart = stylesContent.indexOf('/* ── Masthead (Editorial #208)');
			const toolbarStart = stylesContent.indexOf('/* ── Config toolbar');
			expect(mastheadStart).toBeGreaterThan(0);
			expect(toolbarStart).toBeGreaterThan(mastheadStart);

			const editorialSection = stylesContent.slice(mastheadStart, toolbarStart);
			// Filter out comments
			const cleaned = editorialSection.replace(/\/\*[\s\S]*?\*\//g, '');
			// Should not contain hex colors like #141413, #d97757, etc.
			expect(cleaned).not.toMatch(/:\s*#[0-9a-fA-F]{3,8}/);
		});
	});

	describe('AC-10: Spec documentation', () => {
		it('chat-view.md contains Masthead and Composer & State line specifications', () => {
			expect(specContent).toContain('### Masthead (issue #208)');
			expect(specContent).toContain('### Composer & State line (issue #208)');
			expect(specContent).toContain('NOTE / AGENT / MODEL');
			expect(specContent).toContain('Toolbar coexistence decision');
		});
	});
});
