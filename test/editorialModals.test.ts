import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const repoRoot = resolve(__dirname, '..');

describe('editorial restyle: modals (#211)', () => {
	const stylesPath = resolve(repoRoot, 'styles.css');
	const stylesContent = readFileSync(stylesPath, 'utf8');

	const toolApprovalSource = readFileSync(resolve(repoRoot, 'src/modals/toolApprovalModal.ts'), 'utf8');
	const userInputSource = readFileSync(resolve(repoRoot, 'src/modals/userInputModal.ts'), 'utf8');
	const askUserQuestionSource = readFileSync(resolve(repoRoot, 'src/modals/askUserQuestionModal.ts'), 'utf8');
	const elicitationSource = readFileSync(resolve(repoRoot, 'src/modals/elicitationModal.ts'), 'utf8');
	const vaultScopeSource = readFileSync(resolve(repoRoot, 'src/modals/vaultScopeModal.ts'), 'utf8');
	const folderTreeSource = readFileSync(resolve(repoRoot, 'src/modals/folderTreeModal.ts'), 'utf8');
	const batchLoopProgressSource = readFileSync(resolve(repoRoot, 'src/modals/batchLoopProgressModal.ts'), 'utf8');
	const editModalSource = readFileSync(resolve(repoRoot, 'src/modals/editModal.ts'), 'utf8');

	describe('AC-1: Modal titles masthead treatment', () => {
		it('styles modal titles with bundled serif font and heavy closing rule', () => {
			expect(stylesContent).toMatch(
				/\.synapse-modal-title[\s\S]*?\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-modal-title[\s\S]*?\{[^}]*border-bottom:\s*2px solid var\(--synapse-rule-heavy\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-modal-title[\s\S]*?\{[^}]*font-size:\s*20px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-modal-title[\s\S]*?\{[^}]*font-weight:\s*400/
			);
		});

		it('modal title styling is scoped to the shared synapse-modal-title class only', () => {
			// Every modal applies `synapse-modal-title` directly to its title element
			// (see the sibling test below), so the shared selector doesn't need — and
			// must not use — a wildcard `.modal:has([class*="synapse-"])` fallback that
			// would bleed into unrelated Obsidian modals (#216 review).
			expect(stylesContent).toContain('.synapse-modal-title');
			expect(stylesContent).not.toMatch(/\.modal:has\(\[class\*=["']synapse-["']\]\)/);
		});

		it('all modal TypeScript sources add synapse-modal-title or render titles', () => {
			expect(toolApprovalSource).toContain('synapse-modal-title');
			expect(userInputSource).toContain('synapse-modal-title');
			expect(askUserQuestionSource).toContain('synapse-modal-title');
			expect(elicitationSource).toContain('synapse-modal-title');
			expect(vaultScopeSource).toContain('synapse-modal-title');
			expect(folderTreeSource).toContain('synapse-modal-title');
			expect(batchLoopProgressSource).toContain('synapse-modal-title');
			expect(editModalSource).toContain('synapse-modal-title');
		});
	});

	describe('AC-2: Modal body prose and form labels', () => {
		it('sets modal body prose in the bundled serif', () => {
			expect(stylesContent).toMatch(
				/\.synapse-approval-row\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-userinput-question\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-askq-question-text\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-elicitation-message\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-batch-progress-file\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-edit-textarea\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
		});

		it('styles form labels with uppercase letterspaced interface sans', () => {
			// `.synapse-modal-label`/`.synapse-edit-label`/`.synapse-elicitation-label` share
			// one exact typography combination and are declared together in a grouped rule
			// (#217) rather than three times.
			expect(stylesContent).toMatch(
				/\.synapse-modal-label,[\s\S]*?\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-elicitation-label,[\s\S]*?\.synapse-modal-label,[\s\S]*?\{[^}]*letter-spacing:\s*0\.12em/
			);
			expect(stylesContent).toMatch(
				/\.synapse-elicitation-label,[\s\S]*?\.synapse-modal-label,[\s\S]*?\{[^}]*font-family:\s*var\(--font-interface\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-edit-label\s*\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-elicitation-label,[\s\S]*?\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-askq-chip\s*\{[^}]*text-transform:\s*uppercase/
			);
		});
	});

	describe('AC-3: Modal button system', () => {
		it('styles primary action as small accent block with uppercase letterspaced text', () => {
			expect(stylesContent).toMatch(
				/\.synapse-approval-buttons button\.mod-cta[\s\S]*?\{[^}]*background:\s*var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-buttons button\.mod-cta[\s\S]*?\{[^}]*color:\s*var\(--text-on-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-buttons button\.mod-cta[\s\S]*?\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-buttons button\.mod-cta[\s\S]*?\{[^}]*letter-spacing:\s*0\.08em/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-buttons button\.mod-cta[\s\S]*?\{[^}]*border:\s*none/
			);
		});

		it('styles secondary actions as unboxed text buttons with hover underline', () => {
			expect(stylesContent).toMatch(
				/\.synapse-approval-buttons button:not\(\.mod-cta\)[\s\S]*?\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-buttons button:not\(\.mod-cta\)[\s\S]*?\{[^}]*border:\s*none/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-buttons button:not\(\.mod-cta\)[\s\S]*?\{[^}]*border-bottom:\s*1px solid transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-buttons button:not\(\.mod-cta\)[\s\S]*?\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-buttons button:not\(\.mod-cta\):hover[\s\S]*?\{[^}]*border-bottom-color:\s*var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-buttons button:not\(\.mod-cta\):hover[\s\S]*?\{[^}]*background:\s*transparent/
			);
		});

		it('button system applies across all modal button bars', () => {
			expect(stylesContent).toContain('.synapse-userinput-buttons button.mod-cta');
			expect(stylesContent).toContain('.synapse-askq-buttons button.mod-cta');
			expect(stylesContent).toContain('.synapse-elicitation-buttons button.mod-cta');
			expect(stylesContent).toContain('.synapse-scope-buttons button.mod-cta');
			expect(stylesContent).toContain('.synapse-batch-progress-buttons button.mod-cta');
			expect(stylesContent).toContain('.synapse-edit-btn-primary');
			expect(stylesContent).toContain('.synapse-edit-btn-secondary');
		});
	});

	describe('AC-4: Tool approval caps mono and ledger treatment', () => {
		it('styles tool name in uppercase monospace font', () => {
			expect(stylesContent).toMatch(
				/\.synapse-approval-tool-name\s*\{[^}]*font-family:\s*var\(--font-monospace\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-tool-name\s*\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-tool-name\s*\{[^}]*font-weight:\s*600/
			);
		});

		it('styles arguments and rules with ledger treatment', () => {
			expect(stylesContent).toMatch(
				/\.synapse-approval-details[\s\S]*?\{[^}]*border-left:\s*1px solid var\(--synapse-rule\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-details[\s\S]*?\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-approval-details[\s\S]*?\{[^}]*font-family:\s*var\(--font-monospace\)/
			);
		});

		it('toolApprovalModal.ts applies synapse-approval-tool-name and synapse-ledger classes', () => {
			expect(toolApprovalSource).toContain('synapse-approval-tool-name');
			expect(toolApprovalSource).toContain('synapse-ledger');
		});
	});

	describe('AC-5: Ask-user-question ruled option rows and keyboard operability', () => {
		it('styles option cards as ruled rows without filled backgrounds', () => {
			expect(stylesContent).toMatch(
				/\.synapse-askq-option\s*\{[^}]*border:\s*none/
			);
			expect(stylesContent).toMatch(
				/\.synapse-askq-option\s*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule-soft\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-askq-option\s*\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-askq-option\s*\{[^}]*border-radius:\s*0/
			);
		});

		it('marks selection with accent left border without filled background', () => {
			expect(stylesContent).toMatch(
				/\.synapse-askq-option\.is-selected\s*\{[^}]*border-left:\s*2px solid var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-askq-option\.is-selected\s*\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-askq-option\.is-selected\s*\.synapse-askq-option-label\s*\{[^}]*color:\s*var\(--interactive-accent\)/
			);
		});

		it('styles Other input as ruled underline field', () => {
			expect(stylesContent).toMatch(
				/\.synapse-askq-other-input\s*\{[^}]*border:\s*none/
			);
			expect(stylesContent).toMatch(
				/\.synapse-askq-other-input\s*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-askq-other-input\s*\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-askq-other-input:focus\s*\{[^}]*border-bottom:\s*2px solid var\(--interactive-accent\)/
			);
		});

		it('askUserQuestionModal.ts preserves keyboard handlers and Other option ordering', () => {
			expect(askUserQuestionSource).toContain('synapse-askq-option-other');
			expect(askUserQuestionSource).toContain("e.key === 'ArrowDown'");
			expect(askUserQuestionSource).toContain("e.key === 'ArrowUp'");
			expect(askUserQuestionSource).toContain("e.key === 'Enter'");
			expect(askUserQuestionSource).toContain("e.key === ' '");
			expect(askUserQuestionSource).toContain('buildAskUserQuestionAnswers');
		});
	});

	describe('AC-6: Ruled underline form inputs and focus accessibility', () => {
		it('styles text inputs and textareas with ruled bottom borders and transparent background', () => {
			expect(stylesContent).toMatch(
				/\.synapse-userinput-textarea\s*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-userinput-textarea\s*\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-elicitation-input\s*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-elicitation-input\s*\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-scope-search\s*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-scope-search\s*\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-rename-input\s*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-rename-input\s*\{[^}]*background:\s*transparent/
			);
		});

		it('maintains high-contrast accent bottom border on focus', () => {
			expect(stylesContent).toMatch(
				/\.synapse-userinput-textarea:focus\s*\{[^}]*border-bottom:\s*2px solid var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-elicitation-input:focus\s*\{[^}]*border-bottom:\s*2px solid var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-scope-search:focus\s*\{[^}]*border-bottom:\s*2px solid var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-rename-input:focus\s*\{[^}]*border-bottom:\s*2px solid var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-edit-textarea:focus\s*\{[^}]*border-bottom:\s*2px solid var\(--interactive-accent\)/
			);
		});
	});

	describe('AC-7: Vault scope and folder tree ruled rows and accent selection', () => {
		it('styles tree container with ruled frame and transparent background', () => {
			expect(stylesContent).toMatch(
				/\.synapse-scope-tree\s*\{[^}]*border:\s*none/
			);
			expect(stylesContent).toMatch(
				/\.synapse-scope-tree\s*\{[^}]*border-top:\s*1px solid var\(--synapse-rule-soft\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-scope-tree\s*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule-soft\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-scope-tree\s*\{[^}]*background:\s*transparent/
			);
		});

		it('renders tree items as ruled rows without filled hover/active boxes', () => {
			expect(stylesContent).toMatch(
				/\.synapse-scope-item\s*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule-soft\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-scope-item\s*\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-scope-item:hover\s*\{[^}]*background:\s*var\(--background-modifier-hover\)/
			);
		});

		it('marks active/selected tree items with accent and left rule', () => {
			expect(stylesContent).toMatch(
				/\.synapse-scope-item\.is-active[\s\S]*?\{[^}]*border-left:\s*2px solid var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-scope-item\.is-active[\s\S]*?\{[^}]*color:\s*var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-scope-item\.is-active[\s\S]*?\{[^}]*background:\s*transparent/
			);
		});

		it('vaultScopeModal toggles is-selected on rows', () => {
			expect(vaultScopeSource).toContain("toggleClass('is-selected'");
		});
	});

	describe('AC-8: Edit modal and batch loop progress modal', () => {
		it('styles edit modal cards as ruled rows with serif body copy', () => {
			expect(stylesContent).toMatch(
				/\.synapse-edit-cards\s*\{[^}]*border-top:\s*1px solid var\(--synapse-rule-soft\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-edit-card\s*\{[^}]*border:\s*none/
			);
			expect(stylesContent).toMatch(
				/\.synapse-edit-card\s*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule-soft\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-edit-card\s*\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-edit-card-text\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
		});

		it('styles batch loop progress status with tabular monospace numbers', () => {
			expect(stylesContent).toMatch(
				/\.synapse-batch-progress-status\s*\{[^}]*font-family:\s*var\(--font-monospace\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-batch-progress-status\s*\{[^}]*font-variant-numeric:\s*tabular-nums/
			);
			expect(stylesContent).toMatch(
				/\.synapse-batch-progress-status\s*\{[^}]*text-transform:\s*uppercase/
			);
		});

		it('batch loop progress modal has hairline progress meter track and accent fill', () => {
			expect(stylesContent).toMatch(
				/\.synapse-batch-progress-meter\s*\{[^}]*height:\s*2px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-batch-progress-meter\s*\{[^}]*background:\s*var\(--synapse-rule-soft\)/
			);
			// The fill itself is the shared `.synapse-gauge-fill` primitive (#215) —
			// `.synapse-batch-progress-fill` no longer carries its own duplicate rule.
			expect(stylesContent).toMatch(
				/\.synapse-gauge-fill\s*\{[^}]*background:\s*var\(--interactive-accent\)/
			);
			expect(batchLoopProgressSource).toContain('synapse-batch-progress-meter');
			expect(batchLoopProgressSource).toContain('synapse-batch-progress-fill');
			expect(batchLoopProgressSource).toContain('synapse-gauge-fill');
		});
	});

	describe('AC-10: Theme compliance and zero raw hex colors', () => {
		it('modal styles contain zero raw hex colors', () => {
			const startMarker = '/* ── Modal Titles Masthead Treatment';
			const endMarker = '/* ── Message metadata footer';
			const startIdx = stylesContent.indexOf(startMarker);
			const endIdx = stylesContent.indexOf(endMarker);

			expect(startIdx).toBeGreaterThan(0);
			expect(endIdx).toBeGreaterThan(startIdx);

			const section = stylesContent.slice(startIdx, endIdx);
			const cleaned = section.replace(/\/\*[\s\S]*?\*\//g, '');
			expect(cleaned).not.toMatch(/:\s*#[0-9a-fA-F]{3,8}/);
		});

		it('tree and edit modal styles contain zero raw hex colors', () => {
			const startMarker = '/* ── Vault scope modal';
			const endMarker = '/* ── Settings page models list';
			const startIdx = stylesContent.indexOf(startMarker);
			const endIdx = stylesContent.indexOf(endMarker);

			expect(startIdx).toBeGreaterThan(0);
			expect(endIdx).toBeGreaterThan(startIdx);

			const section = stylesContent.slice(startIdx, endIdx);
			const cleaned = section.replace(/\/\*[\s\S]*?\*\//g, '');
			expect(cleaned).not.toMatch(/:\s*#[0-9a-fA-F]{3,8}/);
		});
	});

	describe('AC-11: Spec documentation', () => {
		it('chat-view.md documents modal editorial specifications', () => {
			const specContent = readFileSync(resolve(repoRoot, '.docs/specs/chat-view.md'), 'utf8');
			expect(specContent).toContain('### Modals (issue #211)');
			expect(specContent).toContain('Masthead title treatment:');
			expect(specContent).toContain('Serif body prose & uppercase form labels:');
			expect(specContent).toContain('Button system:');
			expect(specContent).toContain('Tool approval modal (`ToolApprovalModal`):');
			expect(specContent).toContain('Ask-user-question modal (`AskUserQuestionModal`):');
			expect(specContent).toContain('Ruled underline form inputs:');
			expect(specContent).toContain('Vault scope & Folder tree modals (`VaultScopeModal`, `FolderTreeModal`):');
			expect(specContent).toContain('Edit modal (`EditModal`):');
			expect(specContent).toContain('Batch loop progress modal (`BatchLoopProgressModal`):');
		});
	});
});
