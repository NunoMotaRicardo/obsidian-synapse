import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const repoRoot = resolve(__dirname, '..');

describe('editorial restyle: session sidebar & search tab (#209)', () => {
	const stylesPath = resolve(repoRoot, 'styles.css');
	const stylesContent = readFileSync(stylesPath, 'utf8');
	const sessionSidebarPath = resolve(repoRoot, 'src/view/sessionSidebar.ts');
	const sessionSidebarSource = readFileSync(sessionSidebarPath, 'utf8');
	const searchPanelPath = resolve(repoRoot, 'src/view/searchPanel.ts');
	const searchPanelSource = readFileSync(searchPanelPath, 'utf8');
	const specPath = resolve(repoRoot, '.docs/specs/chat-view.md');
	const specContent = readFileSync(specPath, 'utf8');

	describe('AC-1: Session sidebar rows and metadata', () => {
		it('styles session item as a row with transparent background and no divider lines', () => {
			expect(stylesContent).toMatch(
				/\.synapse-session-item\s*\{[^}]*border-bottom:\s*none/
			);
			expect(stylesContent).toMatch(
				/\.synapse-session-item\s*\{[^}]*background:\s*transparent/
			);
		});

		it('styles session title in bundled serif', () => {
			expect(stylesContent).toMatch(
				/\.synapse-session-name\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
		});

		it('styles session metadata right-aligned, muted, with tabular numbers', () => {
			expect(stylesContent).toMatch(
				/\.synapse-session-time\s*\{[^}]*margin-left:\s*auto/
			);
			expect(stylesContent).toMatch(
				/\.synapse-session-time\s*\{[^}]*font-variant-numeric:\s*tabular-nums/
			);
			expect(stylesContent).toMatch(
				/\.synapse-session-time\s*\{[^}]*color:\s*var\(--text-faint\)/
			);
		});

		it('formats metadata with relative date and message count when available', () => {
			expect(sessionSidebarSource).toContain('this.messages.length');
			expect(sessionSidebarSource).toContain('msg');
		});
	});

	describe('AC-2: Active session accent marking', () => {
		it('marks active session with 2px solid interactive accent left rule', () => {
			expect(stylesContent).toMatch(
				/\.synapse-session-item\.is-active\s*\{[^}]*border-left:\s*2px solid var\(--interactive-accent\)/
			);
		});

		it('keeps active session background transparent without a filled pill or card background', () => {
			expect(stylesContent).toMatch(
				/\.synapse-session-item\.is-active\s*\{[^}]*background:\s*transparent/
			);
		});

		it('highlights active session title with interactive accent color', () => {
			expect(stylesContent).toMatch(
				/\.synapse-session-item\.is-active\s+\.synapse-session-name\s*\{[^}]*color:\s*var\(--interactive-accent\)/
			);
		});
	});

	describe('AC-3: Sidebar section headings', () => {
		it('renders section headings with uppercase letterspaced typography and trailing hairline rule', () => {
			// Uppercase/weight/color come from the shared `.synapse-label-base` primitive (#217).
			expect(stylesContent).toMatch(
				/\.synapse-label-base,[\s\S]*?\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-sidebar-heading\s*\{[^}]*letter-spacing:\s*0\.14em/
			);
			expect(stylesContent).toMatch(
				/\.synapse-sidebar-heading\s*\{[^}]*font-size:\s*10px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-sidebar-heading::after\s*\{[^}]*background:\s*var\(--synapse-rule\)/
			);
		});

		it('renders Background section heading when active background sessions exist', () => {
			expect(sessionSidebarSource).toContain("cls: 'synapse-sidebar-heading synapse-label-base', text: 'Background'");
			expect(sessionSidebarSource).toContain("cls: 'synapse-sidebar-heading synapse-label-base', text: 'Sessions'");
		});
	});

	describe('AC-4: Sidebar controls and keyboard accessibility', () => {
		it('styles sidebar header controls with underline-on-hover pattern', () => {
			expect(stylesContent).toMatch(
				/\.synapse-sidebar-btn-row button:hover[^{]*\{[^}]*border-bottom-color:\s*var\(--interactive-accent\)/
			);
		});

		it('styles inline session action buttons with underline-on-hover pattern', () => {
			expect(stylesContent).toMatch(
				/\.synapse-session-action-btn:hover\s*\{[^}]*border-bottom-color:\s*var\(--interactive-accent\)/
			);
		});

		it('makes session items keyboard-navigable and operable for select, rename, and delete', () => {
			expect(sessionSidebarSource).toContain("item.setAttribute('tabindex', '0')");
			expect(sessionSidebarSource).toContain("item.setAttribute('role', 'button')");
			expect(sessionSidebarSource).toContain("ke.key === 'Enter'");
			expect(sessionSidebarSource).toContain("ke.key === 'F2'");
			expect(sessionSidebarSource).toContain("ke.key === 'Delete'");
		});

		it('renders inline rename and delete action buttons on expanded session items', () => {
			expect(sessionSidebarSource).toContain('synapse-session-actions');
			expect(sessionSidebarSource).toContain('synapse-session-action-btn');
			expect(sessionSidebarSource).toContain('this.renameSession(session.sessionId)');
			expect(sessionSidebarSource).toContain('this.deleteSessionById(session.sessionId)');
		});
	});

	describe('AC-5: Search tab query input and mode switching', () => {
		it('styles search query input with serif font, italic placeholder, and ruled bottom border', () => {
			expect(stylesContent).toMatch(
				/\.synapse-search-input\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-search-input::placeholder\s*\{[^}]*font-style:\s*italic/
			);
			expect(stylesContent).toMatch(
				/\.synapse-search-input-row\s*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule\)/
			);
		});

		it('styles search button as a compact 24px square accent block with 2px radius', () => {
			expect(stylesContent).toMatch(
				/\.synapse-search-btn\s*\{[^}]*width:\s*24px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-search-btn\s*\{[^}]*height:\s*24px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-search-btn\s*\{[^}]*border-radius:\s*2px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-search-btn\s*\{[^}]*background:\s*var\(--interactive-accent\)/
			);
		});

		it('preserves search basic and advanced mode switching with unified toolbar and state line', () => {
			expect(searchPanelSource).toContain('toggleSearchMode(): void');
			expect(searchPanelSource).toContain('updateSearchModeToggle(): void');
			expect(searchPanelSource).toContain('updateSearchAdvancedVisibility(): void');
			expect(searchPanelSource).toContain('synapse-search-composer');
			expect(searchPanelSource).toContain('synapse-search-state-line');
			expect(searchPanelSource).toContain('synapse-search-toolbar');
			expect(searchPanelSource).toContain('synapse-toolbar-sep');
		});
	});

	describe('AC-6: Search results ruled rows and serif excerpts', () => {
		it('renders search results as ruled rows', () => {
			expect(stylesContent).toMatch(
				/\.synapse-search-result\s*\{[^}]*border-bottom:\s*1px solid var\(--synapse-rule-soft\)/
			);
		});

		it('styles matched excerpt in bundled serif font', () => {
			expect(stylesContent).toMatch(
				/\.synapse-search-result-reason\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-search-result-reason\s*\{[^}]*font-size:\s*14\.5px/
			);
		});

		it('highlights matched terms using accent color with no yellow fill', () => {
			expect(stylesContent).toMatch(
				/\.synapse-search-highlight[^{]*\{[^}]*color:\s*var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-search-highlight[^{]*\{[^}]*background:\s*transparent/
			);
			expect(stylesContent).toMatch(
				/\.synapse-search-highlight[^{]*\{[^}]*border-bottom:\s*1px solid var\(--interactive-accent\)/
			);
		});

		it('implements highlightQueryTerms in searchPanel.ts', () => {
			expect(searchPanelSource).toContain('highlightQueryTerms');
			expect(searchPanelSource).toContain('synapse-search-highlight');
		});
	});

	describe('AC-7: Empty and loading states without spinners', () => {
		it('styles sidebar empty state in serif italic', () => {
			expect(stylesContent).toMatch(
				/\.synapse-sidebar-empty\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-sidebar-empty\s*\{[^}]*font-style:\s*italic/
			);
		});

		it('styles search empty state in serif italic without spinner', () => {
			expect(stylesContent).toMatch(
				/\.synapse-search-empty\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-search-empty\s*\{[^}]*font-style:\s*italic/
			);
		});

		it('styles search loading state with sliding hairline bar animation', () => {
			expect(stylesContent).toMatch(
				/\.synapse-search-loading\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-search-loading\s*\{[^}]*font-style:\s*italic/
			);
			expect(stylesContent).toMatch(
				/\.synapse-search-loading-bar\s*\{[^}]*background:\s*var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/@keyframes synapse-slide\s*\{/
			);
		});

		it('searchPanel creates .synapse-search-loading with text and sliding bar, not a spinner', () => {
			expect(searchPanelSource).toContain("cls: 'synapse-search-loading'");
			expect(searchPanelSource).toContain("cls: 'synapse-search-loading-bar'");
			expect(searchPanelSource).not.toContain("setIcon(loadingEl, 'loader'");
			expect(searchPanelSource).not.toContain("setIcon(loadingEl, 'spinner'");
		});
	});

	describe('AC-8: Theme variable compliance (no raw hex colors in restyled components)', () => {
		it('session sidebar and search tab rules contain no raw hex color codes', () => {
			const sidebarStart = stylesContent.indexOf('/* ── Session sidebar (Editorial #209)');
			const promptDropdownStart = stylesContent.indexOf('/* ── Prompt dropdown');
			expect(sidebarStart).toBeGreaterThan(-1);
			expect(promptDropdownStart).toBeGreaterThan(sidebarStart);

			const restyledBlock = stylesContent.substring(sidebarStart, promptDropdownStart);
			const codeWithoutComments = restyledBlock.replace(/\/\*[\s\S]*?\*\//g, '');
			// Match any 3, 4, 6, or 8 digit hex color literal (#fff, #1a1714, etc.)
			const rawHexMatches = codeWithoutComments.match(/#[0-9a-fA-F]{3,8}\b/g);
			expect(rawHexMatches).toBeNull();
		});
	});

	describe('AC-9: Documentation in .docs/specs/chat-view.md', () => {
		it('documents Session sidebar and Search tab Editorial specifications in chat-view.md', () => {
			expect(specContent).toContain('### Session sidebar (issue #209)');
			expect(specContent).toContain('starter list pattern');
			expect(specContent).toContain('### Search tab (issue #209)');
			expect(specContent).toContain('synapse-search-highlight');
			expect(specContent).toContain('synapse-search-loading-bar');
		});
	});
});
