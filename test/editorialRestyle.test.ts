import {describe, it, expect} from 'vitest';
import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {formatToolArgsSummary} from '../src/view/chatRenderer';
import {stripInjectedPromptContext} from '../src/view/utils';

const repoRoot = resolve(__dirname, '..');

describe('editorial restyle: foundations & transcript (#207)', () => {
	const stylesPath = resolve(repoRoot, 'styles.css');
	const stylesContent = readFileSync(stylesPath, 'utf8');

	describe('AC-1 & AC-7 & AC-10: Font embedding, OFL licence & serif fallback', () => {
		it('styles.css embeds the Newsreader faces as base64 data URIs with zero external network URLs', () => {
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
			expect(stylesContent).toContain('https://fonts.gstatic.com/s/newsreader/');
		});

		it('embeds an upright and an italic face, each spanning the 200-800 weight axis', () => {
			const faces = [...stylesContent.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(m => m[1] ?? '');
			const newsreader = faces.filter(f => f.includes("font-family: 'Newsreader'"));
			expect(newsreader).toHaveLength(2);

			const upright = newsreader.find(f => /font-style:\s*normal/.test(f));
			const italic = newsreader.find(f => /font-style:\s*italic/.test(f));
			expect(upright).toBeDefined();
			expect(italic).toBeDefined();

			// A real face for every weight the stylesheet requests (400 body, 500
			// wordmark, 600 strong) so the browser never synthesizes faux-bold or
			// faux-oblique in the transcript.
			for (const face of newsreader) {
				expect(face).toMatch(/font-weight:\s*200 800/);
				expect(face).toContain("src: url('data:font/woff2;base64,");
			}
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
		it('assistant message body renders in the bundled serif at 14px', () => {
			expect(stylesContent).toMatch(
				/\.synapse-msg-assistant\s+\.synapse-msg-body\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toMatch(
				/\.synapse-msg-assistant\s+\.synapse-msg-body\s*\{[^}]*font-size:\s*14px/
			);
			expect(stylesContent).toMatch(
				/\.synapse-msg-assistant\s+\.synapse-msg-body\s*\{[^}]*line-height:\s*1\.5/
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
			// Uppercase/weight/color come from the shared `.synapse-label-base` primitive (#217).
			expect(stylesContent).toMatch(
				/\.synapse-label-base,[\s\S]*?\{[^}]*text-transform:\s*uppercase/
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

		it('chatRenderer.ts renders sentence-case You and Synapse speaker labels with aria-labelledby', () => {
			const chatRendererPath = resolve(repoRoot, 'src/view/chatRenderer.ts');
			const chatRendererSource = readFileSync(chatRendererPath, 'utf8');

			expect(chatRendererSource).toContain("'You'");
			expect(chatRendererSource).toContain("'Claude Synapse'");
			expect(chatRendererSource).toContain('synapse-speaker');
			expect(chatRendererSource).toContain("'aria-labelledby': speakerId");
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

		it('chatRenderer.ts renders tool name in normal case, uppercase in CSS, and tabular elapsed time', () => {
			const chatRendererPath = resolve(repoRoot, 'src/view/chatRenderer.ts');
			const chatRendererSource = readFileSync(chatRendererPath, 'utf8');

			expect(chatRendererSource).toContain("summary.createSpan({cls: 'synapse-tool-call-name', text: toolName});");
			expect(stylesContent).toMatch(
				/\.synapse-tool-call-name\s*\{[^}]*text-transform:\s*uppercase/
			);
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
			// Uppercase/weight/color come from the shared `.synapse-label-base` primitive (#217),
			// added alongside `.synapse-reasoning-summary` in chatRenderer.ts.
			expect(stylesContent).toMatch(
				/\.synapse-label-base,[\s\S]*?\{[^}]*text-transform:\s*uppercase/
			);
			expect(stylesContent).toMatch(
				/\.synapse-reasoning-body\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).toContain('.synapse-reasoning.is-live > summary');
		});

		it('chatRenderer.ts uses sentence-case Thinking… and Reasoning with CSS uppercase', () => {
			const chatRendererPath = resolve(repoRoot, 'src/view/chatRenderer.ts');
			const chatRendererSource = readFileSync(chatRendererPath, 'utf8');

			expect(chatRendererSource).toContain("'Thinking\\u2026'");
			expect(chatRendererSource).toContain("'Reasoning'");
			expect(chatRendererSource).not.toContain('synapse-reasoning-spinner');
		});
	});

	describe('Shared primitives & status styling', () => {
		it('styles.css defines .synapse-rule, .synapse-findings, and .synapse-ledger', () => {
			expect(stylesContent).toContain('.synapse-rule {');
			expect(stylesContent).toContain('.synapse-findings {');
			expect(stylesContent).toContain('.synapse-finding {');
			expect(stylesContent).toContain('.synapse-finding-key {');
			expect(stylesContent).toContain('.synapse-finding-val {');
			expect(stylesContent).toContain('.synapse-ledger,');
			expect(stylesContent).toContain('.synapse-tool-calls {');
		});

		it('status lines use upright Newsreader serif without faux-oblique italic', () => {
			expect(stylesContent).toMatch(
				/\.synapse-thinking\s*\{[^}]*font-family:\s*var\(--synapse-font-serif\)/
			);
			expect(stylesContent).not.toMatch(
				/\.synapse-thinking\s*\{[^}]*font-style:\s*italic/
			);
			expect(stylesContent).not.toMatch(
				/\.synapse-cancelled\s*\{[^}]*font-style:\s*italic/
			);
		});
	});

	describe('Security: formatToolArgsSummary() allowlist and length cap', () => {
		it('extracts known primary keys and normalizes whitespace', () => {
			expect(formatToolArgsSummary({path: '  src/main.ts  '})).toBe('src/main.ts');
			expect(formatToolArgsSummary({file_path: 'a/b/c.md'})).toBe('a/b/c.md');
			expect(formatToolArgsSummary({CommandLine: 'npm   run\nbuild'})).toBe('npm run build');
			expect(formatToolArgsSummary({query: 'Obsidian API'})).toBe('Obsidian API');
		});

		it('caps returned length at 120 characters with ellipsis', () => {
			const longPath = 'a/very/long/path/'.repeat(10);
			const summary = formatToolArgsSummary({path: longPath});
			expect(summary.length).toBe(120);
			expect(summary.endsWith('…')).toBe(true);
		});

		it('does NOT leak unknown keys or credentials into the summary', () => {
			// Third-party MCP or unknown tool with credentials
			expect(formatToolArgsSummary({apiKey: 'sk-ant-secret-key-12345', endpoint: 'https://example.com'})).toBe('');
			expect(formatToolArgsSummary({secretToken: 'ghp_abc123', username: 'admin'})).toBe('');
			expect(formatToolArgsSummary({customKey: 'sensitive-vault-value'})).toBe('');
		});

		it('returns empty string for non-object, null, or empty arguments', () => {
			expect(formatToolArgsSummary(null)).toBe('');
			expect(formatToolArgsSummary(undefined)).toBe('');
			expect(formatToolArgsSummary('hello')).toBe('');
			expect(formatToolArgsSummary(42)).toBe('');
			expect(formatToolArgsSummary({})).toBe('');
			expect(formatToolArgsSummary({path: ''})).toBe('');
		});
	});

	describe('Transcript cleanliness: stripInjectedPromptContext', () => {
		it('leaves clean user prompts untouched', () => {
			const prompt = 'Go through this week\'s meeting notes and pull out unresolved items.';
			expect(stripInjectedPromptContext(prompt)).toBe(prompt);
		});

		it('strips multiline file and image attachments and cursor positions', () => {
			const raw = `Read D:/Temp/notes.txt and check contents.

---
Attached file: general.agent.md
Path: D:\\vault\\agents\\general.agent.md

---
Current cursor position: agents/general.agent.md, line 5, column 0`;
			expect(stripInjectedPromptContext(raw)).toBe('Read D:/Temp/notes.txt and check contents.');
		});

		it('strips inline attachments and cursor positions on single line', () => {
			const raw = `Read D:/Temp/notes.txt again. --- Attached file: general.agent.md Path: D:\\vault\\general.agent.md --- Current cursor position: general.agent.md, line 5, column 0`;
			expect(stripInjectedPromptContext(raw)).toBe('Read D:/Temp/notes.txt again.');
		});

		it('strips workspace path information, vault structure, and self-improve blocks', () => {
			const raw = `Find notes on project X.

[Workspace Path Information]
Active note: D:/vault/Projects/X.md
Working directory: Projects

[Vault Structure]
- Projects
- Daily`;
			expect(stripInjectedPromptContext(raw)).toBe('Find notes on project X.');
		});

		it('strips scope and selection blocks', () => {
			const raw = `Analyze this code.

---
Scope folders:
- src/view

---
Selected text from src/view/chatRenderer.ts (lines 10-20):
function render() {}`;
			expect(stripInjectedPromptContext(raw)).toBe('Analyze this code.');
		});
	});

	describe('Tool ledger visibility & debug gating', () => {
		it('hides diagnostic tool details while retaining task plans when debug is disabled', () => {
			expect(stylesContent).toMatch(
				/\.synapse-hide-debug\s+\.synapse-tool-call,[\s\S]*?\.synapse-hide-debug\s+\.synapse-compaction-block,[\s\S]*?\.synapse-hide-debug\s+\.synapse-msg-metadata\s*\{[^}]*display:\s*none/
			);
			expect(stylesContent).toMatch(
				/\.synapse-hide-debug\s+\.synapse-tool-calls:not\(\.synapse-tool-calls-has-task-panel\)\s*\{[^}]*display:\s*none/
			);
		});
	});
});
