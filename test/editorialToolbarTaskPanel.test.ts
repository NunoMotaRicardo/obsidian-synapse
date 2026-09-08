import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const repoRoot = resolve(__dirname, '..');

describe('editorial restyle: config toolbar, gauge & task panel (#210)', () => {
	const stylesPath = resolve(repoRoot, 'styles.css');
	const stylesContent = readFileSync(stylesPath, 'utf8');
	const configToolbarPath = resolve(repoRoot, 'src/view/configToolbar.ts');
	const configToolbarSource = readFileSync(configToolbarPath, 'utf8');
	const chatRendererPath = resolve(repoRoot, 'src/view/chatRenderer.ts');
	const chatRendererSource = readFileSync(chatRendererPath, 'utf8');
	const specPath = resolve(repoRoot, '.docs/specs/chat-view.md');
	const specContent = readFileSync(specPath, 'utf8');

	describe('AC-1: Config toolbar text controls and slash dividers', () => {
		it('styles .synapse-config-toolbar with uppercase letterspaced typography and no card border', () => {
			// Scoped to `.synapse-config-toolbar` (not the bare `.synapse-toolbar`) so the
			// search tab's toolbar — which reuses `.synapse-toolbar` for its own pre-existing
			// appearance — doesn't inherit this restyle (#215).
			expect(stylesContent).toMatch(
				/\.synapse-config-toolbar\s*\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-config-toolbar\s*\{[^}]*letter-spacing:\s*0\.13em/
			);
			expect(stylesContent).toMatch(
				/\.synapse-config-toolbar\s*\{[^}]*font-size:\s*10px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-config-toolbar\s*\{[^}]*border:\s*none/
			);
			expect(stylesContent).toMatch(
				/\.synapse-config-toolbar\s*\{[^}]*background:\s*transparent/
			);
			expect(configToolbarSource).toContain('synapse-config-toolbar');
		});

		it('styles .synapse-toolbar-sep as thin slash dividers', () => {
			expect(stylesContent).toMatch(
				/\.synapse-toolbar-sep\s*\{[^}]*color:\s*var\(--synapse-rule\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-toolbar-sep\s*\{[^}]*font-size:\s*10px/
			);
		});

		it('styles .synapse-config-toolbar .synapse-select without rectangular dropdown borders or backgrounds', () => {
			// Scoped under `.synapse-config-toolbar` (#215) — the search tab reuses the bare
			// `.synapse-select` class and keeps its own bordered dropdown appearance.
			expect(stylesContent).toMatch(
				/\.synapse-config-toolbar \.synapse-select\s*\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-config-toolbar \.synapse-select\s*\{[^}]*border:\s*none/
			);
			expect(stylesContent).toMatch(
				/\.synapse-config-toolbar \.synapse-select\s*\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-config-toolbar \.synapse-select\s*\{[^}]*letter-spacing:\s*0\.13em/
			);
			expect(stylesContent).toMatch(
				/\.synapse-config-toolbar \.synapse-select:hover\s*\{[^}]*border-bottom-color:\s*var\(--interactive-accent\)/
			);
		});

		it('gives keyboard focus a visible indicator on .synapse-select and .synapse-toolbar-btn', () => {
			expect(stylesContent).toMatch(
				/\.synapse-select:focus-visible,\s*\n?\s*\.synapse-toolbar-btn:focus-visible\s*\{[^}]*outline:\s*1px solid var\(--interactive-accent\)/
			);
		});

		it('styles .synapse-toolbar-btn as uppercase letterspaced with accent hover underline', () => {
			expect(stylesContent).toMatch(
				/\.synapse-toolbar-btn\s*\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-toolbar-btn\s*\{[^}]*letter-spacing:\s*0\.13em/
			);
			expect(stylesContent).toMatch(
				/\.synapse-toolbar-btn:hover\s*\{[^}]*border-bottom-color:\s*var\(--interactive-accent\)/
			);
		});

		it('configToolbar.ts builds agent, model, reasoning, tools, cwd, and debug controls with slash dividers', () => {
			expect(configToolbarSource).toContain('synapse-agent-select');
			expect(configToolbarSource).toContain('synapse-model-select');
			expect(configToolbarSource).toContain('synapse-reasoning-btn');
			expect(configToolbarSource).toContain('synapse-tools-btn');
			expect(configToolbarSource).toContain('synapse-cwd-btn');
			expect(configToolbarSource).toContain('synapse-debug-toggle');
			expect(configToolbarSource).toContain('synapse-toolbar-sep');
		});
	});

	describe('AC-2: State line and toolbar relationship resolution', () => {
		it('hides agent and model from the state line to eliminate duplicated readouts', () => {
			expect(stylesContent).toMatch(
				/\.synapse-state-agent,\s*\n\s*\.synapse-state-model,\s*\n\s*\.synapse-state-sep\s*\{[^}]*display:\s*none/
			);
		});

		it('chat-view.md documents the non-duplication resolution', () => {
			expect(specContent).toContain('Toolbar coexistence decision');
			expect(specContent).toContain('eliminating duplicated agent/model readouts');
		});
	});

	describe('AC-3: Hairline meter context-window gauge', () => {
		it('styles gauge track as a 2px hairline rule without rounded pill', () => {
			expect(stylesContent).toMatch(
				/\.synapse-gauge-track\s*\{[^}]*height:\s*2px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-gauge-track\s*\{[^}]*background:\s*var\(--synapse-rule-soft\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-gauge-track\s*\{[^}]*border-radius:\s*0/
			);
		});

		it('styles gauge fill with interactive accent', () => {
			expect(stylesContent).toMatch(
				/\.synapse-gauge-fill\s*\{[^}]*background:\s*var\(--interactive-accent\)/
			);
		});

		it('styles gauge value in monospace with tabular numbers', () => {
			expect(stylesContent).toMatch(
				/\.synapse-gauge-value\s*\{[^}]*font-family:\s*var\(--font-monospace\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-gauge-value\s*\{[^}]*font-variant-numeric:\s*tabular-nums/
			);
		});

		it('configToolbar.ts builds hairline meter track and tabular mono value in updateContextIndicator', () => {
			expect(configToolbarSource).toContain('synapse-gauge-track');
			expect(configToolbarSource).toContain('synapse-gauge-fill');
			expect(configToolbarSource).toContain('synapse-gauge-value');
			expect(configToolbarSource).toContain('synapse-context-gauge');
		});
	});

	describe('AC-4: Warning and critical states via theme variables and weight', () => {
		it('styles warning state using text-warning and font weight 600', () => {
			expect(stylesContent).toMatch(
				/\.synapse-context-indicator\.is-context-warning\s+\.synapse-gauge-fill\s*\{[^}]*background:\s*var\(--text-warning/
			);
			expect(stylesContent).toMatch(
				/\.synapse-context-indicator\.is-context-warning\s+\.synapse-gauge-value\s*\{[^}]*color:\s*var\(--text-warning/
			);
			expect(stylesContent).toMatch(
				/\.synapse-context-indicator\.is-context-warning\s+\.synapse-gauge-value\s*\{[^}]*font-weight:\s*600/
			);
		});

		it('styles critical state using text-error and font weight 700', () => {
			expect(stylesContent).toMatch(
				/\.synapse-context-indicator\.is-context-critical\s+\.synapse-gauge-fill\s*\{[^}]*background:\s*var\(--text-error\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-context-indicator\.is-context-critical\s+\.synapse-gauge-value\s*\{[^}]*color:\s*var\(--text-error\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-context-indicator\.is-context-critical\s+\.synapse-gauge-value\s*\{[^}]*font-weight:\s*700/
			);
		});
	});

	describe('AC-5: Task/plan panel ruled definition list', () => {
		it('renders task panel reusing synapse-findings primitive', () => {
			expect(chatRendererSource).toContain("cls: 'synapse-task-panel synapse-findings'");
			expect(chatRendererSource).toContain('synapse-finding-key');
			expect(chatRendererSource).toContain('synapse-finding-val');
		});

		it('styles task panel without card border or filled background', () => {
			expect(stylesContent).toMatch(
				/\.synapse-task-panel\s*\{[^}]*border:\s*none/
			);
			expect(stylesContent).toMatch(
				/\.synapse-task-panel\s*\{[^}]*background:\s*transparent/
			);
		});

		it('styles task item with hairline soft separator', () => {
			expect(stylesContent).toMatch(
				/\.synapse-task-item\s*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule-soft\)/
			);
		});

		it('styles status in left column uppercase with 74px width by reusing .synapse-finding-key', () => {
			// The task-status element carries both classes rather than forking a copy of
			// .synapse-finding-key's typography (issue #210's explicit instruction; #215).
			expect(chatRendererSource).toContain("cls: 'synapse-task-item-status synapse-finding-key'");
			expect(stylesContent).toMatch(
				/\.synapse-finding-key\s*\{[^}]*width:\s*74px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-finding-key\s*\{[^}]*text-transform:\s*uppercase/
			);
		});
	});

	describe('AC-6: Typographical task states distinction', () => {
		it('distinguishes active task with accent status, font-weight 600, and accent dot mark', () => {
			expect(stylesContent).toMatch(
				/\.synapse-task-item\.is-in_progress\s+\.synapse-task-item-status\s*\{[^}]*color:\s*var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-task-item\.is-in_progress\s+\.synapse-task-item-status\s*\{[^}]*font-weight:\s*600/
			);
			expect(stylesContent).toMatch(
				/\.synapse-task-active-dot\s*\{[^}]*background:\s*var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-task-active-dot\s*\{[^}]*width:\s*5px/
			);
			expect(chatRendererSource).toContain('synapse-task-active-dot');
		});

		it('distinguishes completed task with line-through and faint text', () => {
			expect(stylesContent).toMatch(
				/\.synapse-task-item\.is-completed\s+\.synapse-task-item-label\s*\{[^}]*text-decoration:\s*line-through/
			);
			expect(stylesContent).toMatch(
				/\.synapse-task-item\.is-completed\s+\.synapse-task-item-label\s*\{[^}]*color:\s*var\(--text-faint\)/
			);
		});

		it('distinguishes pending task with faint status and muted label', () => {
			expect(stylesContent).toMatch(
				/\.synapse-task-item\.is-pending\s+\.synapse-task-item-status\s*\{[^}]*color:\s*var\(--text-faint\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-task-item\.is-pending\s+\.synapse-task-item-label\s*\{[^}]*color:\s*var\(--text-muted\)/
			);
		});

		it('chatRenderer uses uppercase status labels TODO, ACTIVE, DONE without icon badges', () => {
			expect(chatRendererSource).toContain("pending: 'TODO'");
			expect(chatRendererSource).toContain("in_progress: 'ACTIVE'");
			expect(chatRendererSource).toContain("completed: 'DONE'");
		});
	});

	describe('AC-7: Collapsible behavior and live updates', () => {
		it('renders task panel using details and summary elements', () => {
			expect(chatRendererSource).toContain("createEl('details'");
			expect(chatRendererSource).toContain("createEl('summary'");
			expect(chatRendererSource).toContain('synapse-task-panel-header');
		});

		it('preserves open/collapsed state across re-renders in renderTaskPanel', () => {
			expect(chatRendererSource).toContain('wasOpen');
			expect(chatRendererSource).toContain('panel.open = wasOpen');
		});

		it('preserves live elapsed time updating with data-synapse-task-elapsed attribute', () => {
			expect(chatRendererSource).toContain('data-synapse-task-elapsed');
			expect(chatRendererSource).toContain('updateTaskPanelElapsed');
			expect(chatRendererSource).toContain('taskPanelTimer');
		});
	});

	describe('AC-8: Theme compliance and zero raw hex colors', () => {
		it('toolbar, gauge, compaction, and task panel styles contain zero raw hex colors', () => {
			const startMarker = '/* ── Config toolbar (Editorial #210)';
			const endMarker = '/* ── Vault scope modal';
			const startIdx = stylesContent.indexOf(startMarker);
			const endIdx = stylesContent.indexOf(endMarker);

			expect(startIdx).toBeGreaterThan(0);
			expect(endIdx).toBeGreaterThan(startIdx);

			const section = stylesContent.slice(startIdx, endIdx);
			const cleaned = section.replace(/\/\*[\s\S]*?\*\//g, '');
			expect(cleaned).not.toMatch(/:\s*#[0-9a-fA-F]{3,8}/);
		});
	});

	describe('AC-9: Spec documentation', () => {
		it('chat-view.md documents config toolbar, gauge, and task panel editorial specifications', () => {
			expect(specContent).toContain('### Config toolbar, gauge & task panel (issue #210)');
			expect(specContent).toContain('Config toolbar controls:');
			expect(specContent).toContain('Context-window gauge hairline meter:');
			expect(specContent).toContain('Semantic warning and critical gauge states:');
			expect(specContent).toContain('Ruled definition list task panel:');
			expect(specContent).toContain('Typographical task states:');
			expect(specContent).toContain('Collapsible behavior & live updates:');
		});
	});
});
