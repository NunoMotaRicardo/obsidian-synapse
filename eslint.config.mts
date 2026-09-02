import tseslint from 'typescript-eslint';
import globals from "globals";
import { globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

/** Known brand names / acronyms that should NOT be lowercased. */
const ALLOWED_UPPERCASE = new Set([
	'Claude', 'Synapse', 'Mermaid', 'Agent', 'Markdown', 'GitHub', 'URL', 'API', 'LLM',
	'MCP', 'CLI', 'JSON', 'YAML', 'HTML', 'CSS', 'UI', 'ID',
	'Settings', 'Community', 'Enter', 'Ollama', 'OpenAI', 'BYOK',
]);

/**
 * Check whether a string literal is in sentence case.
 * Sentence case = first letter uppercase, remaining words lowercase
 * unless they are brand names or acronyms.
 */
function isSentenceCase(text: string): boolean {
	// Skip very short strings, template-like strings, paths, URLs, placeholders
	if (text.length < 2) return true;
	// Skip pure placeholder-style strings (ghp_…, sk-…, model-id, localhost:)
	if (/^(ghp_|sk-|token|model-|localhost)/i.test(text)) return true;
	// Skip strings that start with a known brand/product followed by ':'
	const brandPrefixMatch = text.match(/^(\w+):/);
	if (brandPrefixMatch && ALLOWED_UPPERCASE.has(brandPrefixMatch[1])) return true;
	// Allow "e.g." prefix — strip it and check the rest
	let checkText = text;
	if (/^e\.g\.\s*/i.test(checkText)) {
		checkText = checkText.replace(/^e\.g\.\s*/i, '').trim();
		if (!checkText) return true;
		// The remainder after "e.g." may start lowercase (it's an example list)
	} else if (/^[a-z]/.test(text)) {
		return false; // must start uppercase
	}
	// Split into sentences (after . ! ?) and check each independently
	const sentences = checkText.split(/(?<=[.!?])\s+/);
	for (const sentence of sentences) {
		const words = sentence.split(/\s+/);
		// Start from word index 1 for the first sentence, 0th word of subsequent sentences is ok (new sentence)
		const startIdx = sentence === sentences[0] ? 1 : 1;
		for (let i = startIdx; i < words.length; i++) {
			// Split hyphenated words and check each part
			const parts = words[i].split('-');
			for (const part of parts) {
				const clean = part.replace(/[^a-zA-Z]/g, '');
				if (!clean) continue;
				if (ALLOWED_UPPERCASE.has(clean)) continue;
				// If word starts uppercase and is not an allowed name, flag it
				if (/^[A-Z]/.test(clean) && !/^[A-Z]+$/.test(clean)) return false;
			}
		}
	}
	return true;
}

export default tseslint.config(
	// obsidianmd's recommended config already includes eslint core recommended
	// and typescript-eslint's type-checked recommended rules, so we don't add
	// tseslint.configs.recommended separately (per the plugin's README).
	...obsidianmd.configs.recommended,
	{
		// obsidianmd's recommended config enables type-checked rules for every
		// *.{ts,mts,...} file, including this config file itself — give the
		// parser project-service info here too (not just under src/**/*.ts).
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.mts',
						'manifest.json',
						'vitest.config.ts',
					],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		files: ['src/**/*.ts'],
		plugins: {
			'synapse-custom': {
				rules: {
					'ui-sentence-case': {
						meta: {
							type: 'suggestion',
							docs: { description: 'Enforce sentence case for UI text in setTitle, setText, setPlaceholder, Notice, createEl, createSpan, createDiv, and attr title/placeholder' },
							messages: {
								notSentenceCase: 'UI text "{{text}}" should use sentence case.',
							},
							schema: [],
						},
						create(context: { report: (opts: { node: unknown; messageId: string; data: Record<string, string> }) => void }) {
							const UI_METHODS = new Set(['setTitle', 'setText', 'setPlaceholder', 'setName', 'setDesc']);
							const CREATE_METHODS = new Set(['createEl', 'createSpan', 'createDiv']);
							const ATTR_TEXT_KEYS = new Set(['title', 'placeholder']);

							/** Report a Literal node if its value is not sentence case. */
							function checkLiteral(node: { type?: string; value?: unknown }) {
								if (node?.type === 'Literal' && typeof node.value === 'string' && !isSentenceCase(node.value)) {
									context.report({ node: node, messageId: 'notSentenceCase', data: { text: node.value } });
								}
							}

							/** Find a Property node by key name inside an ObjectExpression. */
							function findProp(obj: { type?: string; properties?: Array<{ key?: { name?: string; value?: string }; value?: unknown }> }, key: string) {
								if (obj?.type !== 'ObjectExpression') return undefined;
								return obj.properties?.find(
									(p: { key?: { name?: string; value?: string } }) =>
										(p.key?.name === key) || (p.key?.value === key)
								);
							}

							return {
								// .setTitle('Text'), .setText('Text'), etc.
								CallExpression(node: {
									callee?: { type?: string; property?: { name?: string }; name?: string };
									arguments?: Array<{ type?: string; value?: unknown; properties?: unknown[] }>;
								}) {
									const callee = node.callee;
									const args = node.arguments;

									// --- .setTitle / .setText / .setPlaceholder / .setName / .setDesc ---
									if (
										callee?.type === 'MemberExpression' &&
										typeof callee.property?.name === 'string' &&
										UI_METHODS.has(callee.property.name)
									) {
										const arg = args?.[0];
										checkLiteral(arg as { type?: string; value?: unknown });
									}

									// --- .createEl / .createSpan / .createDiv with {text: '...'} ---
									if (
										callee?.type === 'MemberExpression' &&
										typeof callee.property?.name === 'string' &&
										CREATE_METHODS.has(callee.property.name)
									) {
										// Options object is 1st arg for createSpan/createDiv, 2nd arg for createEl
										const optsArg = callee.property.name === 'createEl' ? args?.[1] : args?.[0];
										if (optsArg?.type === 'ObjectExpression') {
											const textProp = findProp(optsArg as Parameters<typeof findProp>[0], 'text');
											if (textProp) checkLiteral(textProp.value as { type?: string; value?: unknown });

											// Also check attr: {title: '...', placeholder: '...'}
											const attrProp = findProp(optsArg as Parameters<typeof findProp>[0], 'attr');
											if (attrProp?.value && (attrProp.value as { type?: string }).type === 'ObjectExpression') {
												const attrObj = attrProp.value as Parameters<typeof findProp>[0];
												for (const key of ATTR_TEXT_KEYS) {
													const kp = findProp(attrObj, key);
													if (kp) checkLiteral(kp.value as { type?: string; value?: unknown });
												}
											}
										}
									}

									// --- new Notice('Text') via CallExpression for `Notice(...)` ---
									if (
										callee?.type === 'Identifier' &&
										(callee as unknown as { name: string }).name === 'Notice'
									) {
										const arg = args?.[0];
										checkLiteral(arg as { type?: string; value?: unknown });
									}
								},
								// new Notice('Text') via NewExpression
								NewExpression(node: { callee?: { type?: string; name?: string }; arguments?: Array<{ type?: string; value?: unknown }> }) {
									if (
										node.callee?.type === 'Identifier' &&
										node.callee.name === 'Notice'
									) {
										const arg = node.arguments?.[0];
										checkLiteral(arg as { type?: string; value?: unknown });
									}
								},
							};
						},
					},
				},
			},
		},
		rules: {
			'synapse-custom/ui-sentence-case': 'error',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			// obsidianmd's own sentence-case rule doesn't know the plugin's own name and
			// flags correctly-capitalized "Synapse" in UI copy ("Chat with Synapse", "Open
			// Synapse") as a violation. `brands`/`acronyms` *replace* the rule's own default
			// lists rather than extend them (confirmed against its source), so these are
			// copies of eslint-plugin-obsidianmd@0.4.2's DEFAULT_BRANDS/DEFAULT_ACRONYMS
			// (src/lib/rules/ui/brands.ts, acronyms.ts) plus this plugin's own terms
			// ('Synapse', 'Ollama', 'Sonnet', 'BYOK', 'USD'). Only proper nouns belong in
			// `brands` — generic words like "Agent"/"Enter"/"Settings" (from our own
			// ALLOWED_UPPERCASE list above) caused false positives mid-sentence when tried.
			'obsidianmd/ui/sentence-case': ['warn', {
				enforceCamelCaseLower: true,
				brands: [
					'iOS', 'iPadOS', 'macOS', 'Windows', 'Android', 'Linux',
					'Obsidian', 'Obsidian Sync', 'Obsidian Publish',
					'Google', 'Gemini', 'Vertex AI', 'OpenAI', 'GPT', 'Anthropic', 'Claude', 'Cursor', 'Microsoft',
					'Google Drive', 'Dropbox', 'OneDrive', 'iCloud Drive',
					'YouTube', 'Slack', 'Discord', 'Telegram', 'WhatsApp', 'Twitter', 'X',
					'Readwise', 'Zotero',
					'Excalidraw', 'Mermaid',
					'Markdown', 'LaTeX', 'JavaScript', 'TypeScript', 'Node.js',
					'npm', 'pnpm', 'Yarn', 'Git', 'GitHub', 'GitLab',
					'Anki', 'CalDAV', 'CardDAV', 'Evernote', 'IntelliJ IDEA', 'Jekyll', 'Logseq', 'Notion',
					'PyCharm', 'React', 'Reddit', 'Roam Research', 'Svelte', 'VS Code', 'Visual Studio Code',
					'WebDAV', 'WebStorm',
					// Synapse-specific additions:
					'Synapse', 'Ollama', 'Sonnet',
				],
				acronyms: [
					'API', 'HTTP', 'HTTPS', 'URL', 'DNS', 'TCP', 'IP', 'SSH', 'TLS', 'SSL', 'FTP', 'SFTP', 'SMTP',
					'JSON', 'XML', 'HTML', 'CSS', 'PDF', 'CSV', 'YAML', 'SQL', 'PNG', 'JPG', 'JPEG', 'GIF', 'SVG',
					'2FA', 'MFA', 'OAuth', 'JWT', 'LDAP', 'SAML',
					'SDK', 'IDE', 'CLI', 'GUI', 'CRUD', 'SOAP',
					'CPU', 'GPU', 'RAM', 'SSD', 'USB',
					'UI', 'OK',
					'RSS', 'S3',
					'ID',
					'UUID', 'GUID', 'SHA', 'MD5', 'ASCII', 'UTF-8', 'UTF-16', 'DOM', 'CDN', 'FAQ', 'AI', 'ML', 'LLM',
					// Synapse-specific additions:
					'BYOK', 'USD', 'MCP',
				],
				// Whole strings to exempt entirely — these contain literal, case-sensitive
				// shell commands / key-format placeholders, not prose, so sentence case
				// doesn't apply (obsidianmd/* rules can't be disabled via inline comments —
				// see eslint-comments/no-restricted-disable in its recommended config).
				ignoreRegex: [
					'sk-ant-', // Anthropic API key placeholder format
					'claude login', // literal CLI command
					'ollama serve', // literal CLI command
					'ollama pull', // literal CLI command
					'^Feature -> Agent map$', // setting name — "Agent" is this plugin's own
					// domain term (matches synapse-custom/ui-sentence-case's ALLOWED_UPPERCASE
					// above), not a word the rule's brand dictionary knows about
					'^e\\.g\\.', // lowercase "e.g." lead-in — matches our own hand-rolled
					// synapse-custom/ui-sentence-case rule's convention above
					'^Custom request timeout in seconds\\. 0 ', // "0 uses…" — a numeral can't
					// itself be capitalized, and forcing the next word up ("0 Uses…") reads
					// worse than natural lowercase continuation
					'_synapse/triggers/', // literal (lowercase) vault folder path, not prose —
					// the rule's suggested fix would incorrectly capitalize it to "_Synapse/…"
				],
			}],
		},
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.mts',
						'manifest.json',
						'vitest.config.ts',
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	{
		// test/** runs under vitest's `node` environment (see vitest.config.ts), not
		// inside Obsidian's Electron renderer — `window` doesn't exist there, so the
		// obsidianmd rules that assume a browser/popout-window context don't apply.
		files: ['test/**/*.ts'],
		rules: {
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/no-global-this': 'off',
		},
	},
	{
		// test/setup.ts is a vi.mock() scaffold reproducing the shape of the Obsidian API
		// (App/Plugin/Setting/Modal/etc.) purely for test wiring — `any` here is the
		// correct, deliberate type for constructor args/callbacks that mirror Obsidian's
		// own loosely-typed surface, not a mistake to fix. (@typescript-eslint/no-explicit-any
		// can't be disabled via inline comment — see eslint-comments/no-restricted-disable.)
		files: ['test/setup.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
		},
	},
	{
		files: ['src/main.ts'],
		rules: {
			// Permanently disabled (investigated under #115, settled here):
			//
			// no-plugin-id-in-command-id — Obsidian already namespaces every registered
			// command as `<plugin-id>:<command-id>` (see obsidian.d.ts Plugin.addCommand),
			// so the rule's stated premise ("avoid conflicts with other plugins") doesn't
			// apply — the id can never collide across plugins regardless of this prefix.
			// What does apply is CLAUDE.md's "don't rename command IDs without a migration
			// path": Obsidian's hotkey store keys a user's custom binding to the full
			// `synapse:<command-id>` string, and the plugin API exposes no rename/alias
			// primitive (only addCommand/removeCommand) — changing an id makes Obsidian
			// treat it as a brand-new command, silently orphaning any binding the user set.
			// No safe migration exists, so this stays off for good.
			//
			// no-default-hotkeys — shipping default hotkeys (Mod+Shift+K/L/E) for this
			// plugin's most-used commands is a deliberate, longstanding UX choice, not an
			// oversight. Removing them would silently strip a working keybinding for every
			// existing user with no prompt or replacement — a real regression, not a
			// lint fix. Kept as-is.
			'obsidianmd/commands/no-plugin-id-in-command-id': 'off',
			'obsidianmd/commands/no-default-hotkeys': 'off',
		},
	},
	{
		files: ['src/providerModels.ts'],
		rules: {
			// This module's fetch() calls talk to user-configured local/BYOK provider base
			// URLs (Ollama, OpenAI-compatible endpoints, Azure, Anthropic-compatible) —
			// requestUrl() has different semantics (buffers the whole response instead of
			// streaming, different error/CORS behavior) that would need real verification
			// against each provider shape, not a blind lint-driven swap. Left as-is here;
			// see #115 for follow-up.
			'no-restricted-globals': 'off',
		},
	},
	{
		files: ['src/configWriter.ts'],
		rules: {
			// deleteArtifact() intentionally always uses Obsidian's local .trash folder
			// (vault.trash(file, false)), not the user's system trash preference — this is
			// the plugin deleting its own generated artifact files (not user notes), and
			// switching to FileManager.trashFile() would change that behavior (deferring to
			// the "Deleted files" setting instead). Needs its own design/verification pass,
			// not a blind lint-driven swap — left as-is here; see #115 for follow-up.
			'obsidianmd/prefer-file-manager-trash-file': 'off',
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		".claude",
		".gemini",
		// Standalone build/CI scripts — not plugin source, and outside the TS project
		// service, so the typed linter cannot parse them.
		".github",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
