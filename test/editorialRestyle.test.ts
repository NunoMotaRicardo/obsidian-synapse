import {describe, it, expect} from 'vitest';
import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';

const repoRoot = resolve(__dirname, '..');

describe('editorial restyle: foundations & transcript (#207)', () => {
	const stylesPath = resolve(repoRoot, 'styles.css');
	const stylesContent = readFileSync(stylesPath, 'utf8');

	describe('AC-1 & AC-7 & AC-10: Font embedding, OFL licence & serif fallback', () => {
		it('styles.css embeds Newsreader 400 as a base64 data URI with zero external network URLs', () => {
			expect(stylesContent).toContain("@font-face");
			expect(stylesContent).toContain("font-family: 'Newsreader'");
			expect(stylesContent).toContain("src: url('data:font/woff2;base64,");
			expect(stylesContent).toContain("format('woff2')");
			expect(stylesContent).not.toMatch(/url\(['"]?https?:\/\//i);
		});

		it('styles.css specifies Latin subset unicode-range for Newsreader', () => {
			expect(stylesContent).toContain('unicode-range: U+0000-00FF');
		});

		it('styles.css carries the full SIL OFL 1.1 text, copyright notice, provenance, and subsetting details', () => {
			expect(stylesContent).toContain('Copyright 2020 The Newsreader Project Authors');
			expect(stylesContent).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
			expect(stylesContent).toContain('https://github.com/productiontype/Newsreader');
			expect(stylesContent).toContain('pyftsubset Newsreader-Regular.ttf');
		});

		it('OFL.txt exists at the repository root with full license text', () => {
			const oflPath = resolve(repoRoot, 'OFL.txt');
			expect(existsSync(oflPath)).toBe(true);
			const oflText = readFileSync(oflPath, 'utf8');
			expect(oflText).toContain('Copyright 2020 The Newsreader Project Authors');
			expect(oflText).toContain('SIL OPEN FONT LICENSE Version 1.1');
		});

		it('declares the system serif fallback stack in CSS variable', () => {
			expect(stylesContent).toContain(
				"--synapse-font-serif: 'Newsreader', Georgia, 'Iowan Old Style', 'Times New Roman', serif;"
			);
		});
	});

	describe('AC-1 & AC-3: Transcript voice split and user washed block', () => {
		it('assistant message body renders in the bundled serif at ~15.5px', () => {
			expect(stylesContent).toMatch(
				/\.synapse-msg-assistant\s+\.synapse-msg-body\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-msg-assistant\s+\.synapse-msg-body\s*\{[^}]*font-size:\s*15\.5px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-msg-assistant\s+\.synapse-msg-body\s*\{[^}]*line-height:\s*1\.62/
			);
		});

		it('user turn renders as a washed block with a 2px accent left rule, no bubble border-radius, interface sans', () => {
			expect(stylesContent).toMatch(
				/\.synapse-msg-user\s*\{[^}]*border-left:\s*2px solid var\(--interactive-accent\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-msg-user\s*\{[^}]*border-radius:\s*0/
			);
			expect(stylesContent).toMatch(
				/\.synapse-msg-user\s*\{[^}]*font-family:\s*var\(--font-interface\)/
			);
			expect(stylesContent).toContain('--synapse-user-wash: color-mix(in srgb, var(--interactive-accent) 12%, var(--background-primary));');
		});
	});

	describe('AC-2: Speaker labels', () => {
		it('styles.css defines .synapse-speaker with uppercase letterspacing and trailing hairline rule', () => {
			expect(stylesContent).toMatch(
				/\.synapse-speaker\s*\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-speaker\s*\{[^}]*letter-spacing:\s*0\.15em/
			);
			expect(stylesContent).toMatch(
				/\.synapse-speaker::after\s*\{[^}]*height:\s*1px/
			);
			expect(stylesContent).toContain('.synapse-speaker.you');
			expect(stylesContent).toContain('.synapse-speaker.ai');
		});

		it('chatRenderer.ts renders YOU and SYNAPSE speaker labels', () => {
			const chatRendererPath = resolve(repoRoot, 'src/view/chatRenderer.ts');
			const chatRendererSource = readFileSync(chatRendererPath, 'utf8');

			expect(chatRendererSource).toContain("'YOU'");
			expect(chatRendererSource).toContain("'SYNAPSE'");
			expect(chatRendererSource).toContain('synapse-speaker');
		});
	});

	describe('AC-4 & AC-5: Tool calls margin rail and live pulse', () => {
		it('styles.css styles tool calls as a monospace margin rail with hairline left border', () => {
			expect(stylesContent).toMatch(
				/\.synapse-tool-calls[^{]*\{[^}]*border-left:\s*1px solid var\(--synapse-rule\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-tool-call-summary[^{]*\{[^}]*font-family:\s*var\(--font-monospace\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-tool-call-time[^{]*\{[^}]*font-variant-numeric:\s*tabular-nums/
			);
		});

		it('styles.css defines live pulse animation for running tool calls and no spinner', () => {
			expect(stylesContent).toContain('@keyframes synapse-pulse');
			expect(stylesContent).toMatch(
				/\.synapse-tool-call-summary\.is-live\s+\.synapse-tool-call-time[^{]*\{[^}]*animation:\s*synapse-pulse/
			);
		});

		it('chatRenderer.ts formats tool name in uppercase, args summary in mono, and tabular elapsed time', () => {
			const chatRendererPath = resolve(repoRoot, 'src/view/chatRenderer.ts');
			const chatRendererSource = readFileSync(chatRendererPath, 'utf8');

			expect(chatRendererSource).toContain('toolName.toUpperCase()');
			expect(chatRendererSource).toContain('formatToolArgsSummary');
			expect(chatRendererSource).toContain('synapse-tool-call-arg');
			expect(chatRendererSource).toContain('synapse-tool-call-time');
			expect(chatRendererSource).toContain('is-live');
			// Old spinner is gone from chatRenderer
			expect(chatRendererSource).not.toContain('synapse-tool-call-spinner');
		});
	});

	describe('AC-6: Reasoning blocks', () => {
		it('styles.css styles reasoning blocks with hairline rule, uppercase label, live pulse, and serif body', () => {
			expect(stylesContent).toMatch(
				/\.synapse-reasoning\s*\{[^}]*border-left:\s*1px solid var\(--synapse-rule\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-reasoning\s*>\s*summary\s*\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-reasoning-body\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toContain('.synapse-reasoning.is-live > summary');
		});

		it('chatRenderer.ts uses THINKING… while streaming and REASONING when complete/rendered', () => {
			const chatRendererPath = resolve(repoRoot, 'src/view/chatRenderer.ts');
			const chatRendererSource = readFileSync(chatRendererPath, 'utf8');

			expect(chatRendererSource).toContain("'THINKING\\u2026'");
			expect(chatRendererSource).toContain("'REASONING'");
			expect(chatRendererSource).not.toContain('synapse-reasoning-spinner');
		});
	});

	describe('Shared primitives', () => {
		it('styles.css defines .synapse-rule, .synapse-findings, and .synapse-ledger', () => {
			expect(stylesContent).toContain('.synapse-rule {');
			expect(stylesContent).toContain('.synapse-findings {');
			expect(stylesContent).toContain('.synapse-finding {');
			expect(stylesContent).toContain('.synapse-finding-key {');
			expect(stylesContent).toContain('.synapse-finding-val {');
			expect(stylesContent).toContain('.synapse-ledger,');
			expect(stylesContent).toContain('.synapse-ledger-row,');
		});
	});
});
