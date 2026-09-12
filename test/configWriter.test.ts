import {describe, it, expect} from 'vitest';
import type {App} from 'obsidian';
import {
	parseFrontmatter,
	ensureFolder,
	writeSkill,
	scanVaultStructure,
	scanAgents,
	ensureImproveSynapseSkill,
	IMPROVE_SYNAPSE_SKILL_NAME,
	persistToolApprovalRules,
} from '../src/configWriter';
import {createMockApp, seedFile, seedFolder, readVaultFile} from './setup';

// ---------------------------------------------------------------------------
// parseFrontmatter — round-tripping, malformed input, quoting/escaping
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
	it('returns empty meta and the full content as body when there is no frontmatter block', () => {
		const {meta, body} = parseFrontmatter('Just a plain note with no frontmatter.');
		expect(meta).toEqual({});
		expect(body).toBe('Just a plain note with no frontmatter.');
	});

	it('does not match an unterminated frontmatter block (missing closing ---)', () => {
		const content = '---\ndescription: hi\n\nNo closing fence.';
		const {meta, body} = parseFrontmatter(content);
		expect(meta).toEqual({});
		expect(body).toBe(content);
	});

	it('does not match a malformed fence (two dashes instead of three)', () => {
		const content = '--\ndescription: hi\n--\nBody';
		const {meta, body} = parseFrontmatter(content);
		expect(meta).toEqual({});
		expect(body).toBe(content);
	});

	it('parses an empty frontmatter block (blank line between fences)', () => {
		// FM_RE requires a `\n` immediately before the closing `---`; an empty
		// frontmatter block therefore needs a blank line between the fences —
		// `---\n---\n...` (no blank line) does not match at all and the whole
		// content is treated as body (see the next test).
		const {meta, body} = parseFrontmatter('---\n\n---\nBody text');
		expect(meta).toEqual({});
		expect(body).toBe('Body text');
	});

	it('treats adjacent fences with no blank line between them as no frontmatter at all', () => {
		const content = '---\n---\nBody text';
		const {meta, body} = parseFrontmatter(content);
		expect(meta).toEqual({});
		expect(body).toBe(content);
	});

	it('parses frontmatter with no body after it', () => {
		const {meta, body} = parseFrontmatter('---\nname: foo\n---\n');
		expect(meta).toEqual({name: 'foo'});
		expect(body).toBe('');
	});

	it('parses simple scalar fields', () => {
		const {meta, body} = parseFrontmatter('---\nname: my-agent\ndescription: A test agent\n---\nHello body.');
		expect(meta).toEqual({name: 'my-agent', description: 'A test agent'});
		expect(body).toBe('Hello body.');
	});

	it('strips surrounding double quotes from a scalar value', () => {
		const {meta} = parseFrontmatter('---\ndescription: "quoted value"\n---\n');
		expect(meta['description']).toBe('quoted value');
	});

	it('strips surrounding single quotes from a scalar value', () => {
		const {meta} = parseFrontmatter("---\ndescription: 'quoted value'\n---\n");
		expect(meta['description']).toBe('quoted value');
	});

	it('preserves a colon inside a quoted value (splits only on the first colon)', () => {
		const {meta} = parseFrontmatter('---\ndescription: "10:30 meeting"\n---\n');
		expect(meta['description']).toBe('10:30 meeting');
	});

	it('parses a YAML list value', () => {
		const {meta} = parseFrontmatter('---\ntools:\n  - Read\n  - Write\n---\n');
		expect(meta['tools']).toEqual(['Read', 'Write']);
	});

	it('parses a single-item YAML list', () => {
		const {meta} = parseFrontmatter('---\ntools:\n  - Read\n---\n');
		expect(meta['tools']).toEqual(['Read']);
	});

	it('treats a list item containing a colon as a whole list value, not a nested key', () => {
		const {meta} = parseFrontmatter('---\nnotes:\n  - key: value\n---\n');
		expect(meta['notes']).toEqual(['key: value']);
	});

	it('handles CRLF line endings throughout the frontmatter block and body', () => {
		const content = '---\r\nname: foo\r\ndescription: bar\r\n---\r\nBody line 1\r\nBody line 2\r\n';
		const {meta, body} = parseFrontmatter(content);
		expect(meta).toEqual({name: 'foo', description: 'bar'});
		expect(body).toBe('Body line 1\r\nBody line 2\r\n');
	});

	it('handles CRLF line endings inside a YAML list', () => {
		const content = '---\r\ntools:\r\n  - Read\r\n  - Write\r\n---\r\nBody\r\n';
		const {meta} = parseFrontmatter(content);
		expect(meta['tools']).toEqual(['Read', 'Write']);
	});

	it('round-trips a value written by writeSkill through serializeFmField/buildMarkdown', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeSkill(app, '_synapse/skills', {
			name: 'My Skill',
			description: 'Handles: research and citations',
			content: 'Be helpful.',
		});
		const raw = await readVaultFile(app, path);
		const {meta} = parseFrontmatter(raw);
		// A value containing a colon round-trips correctly: the writer quotes it,
		// and the parser only splits on the *first* colon in the line (the one
		// separating the key from the value), so the value's own colon survives.
		expect(meta['description']).toBe('Handles: research and citations');
	});

	it('round-trips a value with leading/trailing whitespace', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeSkill(app, '_synapse/skills', {
			name: 'Padded',
			description: '  padded value  ',
			content: '',
		});
		const raw = await readVaultFile(app, path);
		const {meta} = parseFrontmatter(raw);
		expect(meta['description']).toBe('  padded value  ');
	});

	// --- Escaping round-trip (#161) ---
	//
	// serializeFmField escapes embedded backslashes and double quotes (`\` -> `\\`,
	// `"` -> `\"`) when it quotes a value, and parseFrontmatter un-escapes them
	// back in a single pass when it strips the outer quotes. Write and read must
	// stay exact inverses of each other.
	it('round-trips a value containing a double quote', async () => {
		const app = createMockApp() as unknown as App;
		const original = 'He said "hi" to me';
		const path = await writeSkill(app, '_synapse/skills', {
			name: 'Quote Value',
			description: original,
			content: '',
		});
		const raw = await readVaultFile(app, path);
		const {meta} = parseFrontmatter(raw);
		expect(meta['description']).toBe(original);
	});

	it('round-trips a value containing backslashes', async () => {
		const app = createMockApp() as unknown as App;
		// The colon is what triggers quoting/escaping for this value.
		const original = 'C:\\Users\\me: path';
		const path = await writeSkill(app, '_synapse/skills', {
			name: 'Backslash Value',
			description: original,
			content: '',
		});
		const raw = await readVaultFile(app, path);
		const {meta} = parseFrontmatter(raw);
		expect(meta['description']).toBe(original);
	});

	it('round-trips a value ending in a backslash immediately before a quote (single-pass un-escape trap)', async () => {
		const app = createMockApp() as unknown as App;
		// A naive two-step un-escape (`\\` -> `\` fully, then `\"` -> `"`) mis-pairs this:
		// the escaped form is `...end\\\"` (escaped trailing backslash + escaped quote), and
		// replacing all `\\` first turns it into `...end\"` before the quote pass ever runs,
		// which then wrongly consumes the literal backslash as part of a fake escape sequence.
		const original = 'value ending in backslash\\" and more';
		const path = await writeSkill(app, '_synapse/skills', {
			name: 'Backslash Before Quote',
			description: original,
			content: '',
		});
		const raw = await readVaultFile(app, path);
		const {meta} = parseFrontmatter(raw);
		expect(meta['description']).toBe(original);
	});

	it('leaves an unquoted value containing a backslash unchanged (no colon/quote/newline to trigger escaping)', async () => {
		const app = createMockApp() as unknown as App;
		const original = 'Users\\me\\docs';
		const path = await writeSkill(app, '_synapse/skills', {
			name: 'Plain Backslash',
			description: original,
			content: '',
		});
		const raw = await readVaultFile(app, path);
		// Confirm it was written unquoted (the case that was already correct and must not regress).
		expect(raw).toContain(`description: ${original}`);
		const {meta} = parseFrontmatter(raw);
		expect(meta['description']).toBe(original);
	});

	it('round-trips a value combining backslashes, colons, and quotes (write → parse exactness)', async () => {
		const app = createMockApp() as unknown as App;
		// Formerly asserted byte-identity across repeated modifyArtifact cycles; that
		// writer is gone (#232). The write → parse round trip on the live writer
		// (writeSkill) must still be exact for the hardest combined value.
		const original = 'C:\\Users\\me: path with "quotes"';
		const path = await writeSkill(app, '_synapse/skills', {
			name: 'Cycle Value',
			description: original,
			content: '',
		});
		const raw = await readVaultFile(app, path);
		const {meta} = parseFrontmatter(raw);
		expect(meta['description']).toBe(original);
	});
});

// ---------------------------------------------------------------------------
// ensureFolder
// ---------------------------------------------------------------------------

describe('ensureFolder', () => {
	it('creates a top-level folder that does not yet exist', async () => {
		const app = createMockApp() as unknown as App;
		await ensureFolder(app, 'notes');
		expect(app.vault.getAbstractFileByPath('notes')).not.toBeNull();
	});

	it('creates intermediate folders one segment at a time', async () => {
		const app = createMockApp() as unknown as App;
		await ensureFolder(app, '_synapse/agents/nested');
		expect(app.vault.getAbstractFileByPath('_synapse')).not.toBeNull();
		expect(app.vault.getAbstractFileByPath('_synapse/agents')).not.toBeNull();
		expect(app.vault.getAbstractFileByPath('_synapse/agents/nested')).not.toBeNull();
	});

	it('is a no-op when the folder already exists', async () => {
		const app = createMockApp() as unknown as App;
		await ensureFolder(app, 'notes');
		await expect(ensureFolder(app, 'notes')).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// writeSkill — kebab naming, folder creation
// ---------------------------------------------------------------------------

describe('writeSkill', () => {
	it('writes SKILL.md inside a kebab-case subfolder', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeSkill(app, '_synapse/skills', {
			name: 'APA Citations',
			description: 'desc',
			content: 'content',
		});
		expect(path).toBe('_synapse/skills/apa-citations/SKILL.md');
	});
});

// ---------------------------------------------------------------------------
// scanVaultStructure
// ---------------------------------------------------------------------------

describe('scanVaultStructure', () => {
	it('excludes the _synapse folder, the config dir, and dot-folders', async () => {
		const app = createMockApp() as unknown as App;
		seedFolder(app, '_synapse');
		seedFolder(app, app.vault.configDir); // exercises the exclusion generically, not tied to the literal ".obsidian"
		seedFolder(app, '.trash');
		seedFolder(app, 'inbox');
		seedFile(app, 'inbox/note.md', '');

		const result = scanVaultStructure(app);
		expect(result.map(r => r.name)).toEqual(['inbox']);
	});

	it('sorts folders alphabetically and reports child counts', async () => {
		const app = createMockApp() as unknown as App;
		seedFolder(app, 'zeta');
		seedFolder(app, 'alpha');
		seedFile(app, 'alpha/a.md', '');
		seedFile(app, 'alpha/b.md', '');

		const result = scanVaultStructure(app);
		expect(result.map(r => r.name)).toEqual(['alpha', 'zeta']);
		expect(result.find(r => r.name === 'alpha')?.fileCount).toBe(2);
		expect(result.find(r => r.name === 'zeta')?.fileCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// scanAgents — read side of the round trip
// ---------------------------------------------------------------------------

describe('scanAgents', () => {
	it('returns [] when the folder does not exist', async () => {
		const app = createMockApp() as unknown as App;
		expect(await scanAgents(app, '_synapse/agents')).toEqual([]);
	});

	it('reads back an agent file with hand-written frontmatter, including tools/skills lists', async () => {
		// Seeded directly rather than via a writer: writeAgent is gone (#232) and
		// writeSkill writes skills (no tools/skills lists), so this covers scanAgents'
		// list parsing against a realistic on-disk artifact shape.
		const app = createMockApp() as unknown as App;
		seedFile(app, '_synapse/agents/round-trip.md', [
			'---',
			'description: desc',
			'tools:',
			'  - Read',
			'  - Write',
			'---',
			'',
			'Body content.',
			'',
		].join('\n'));
		const agents = await scanAgents(app, '_synapse/agents');
		expect(agents).toHaveLength(1);
		expect(agents[0]).toMatchObject({
			name: 'round-trip',
			description: 'desc',
			instructions: 'Body content.',
			tools: ['Read', 'Write'],
		});
	});
});

// ---------------------------------------------------------------------------
// persistToolApprovalRules (issue #197)
// ---------------------------------------------------------------------------

interface TestSettingsFile {
	$schema?: string;
	model?: string;
	permissions?: {
		allow?: string[];
		deny?: string[];
		defaultMode?: string;
	};
}

function parseSettingsFile(raw: string): TestSettingsFile {
	return JSON.parse(raw) as TestSettingsFile;
}

describe('persistToolApprovalRules', () => {
	it('creates _synapse/settings.json when absent, with the rule under permissions.allow', async () => {
		const app = createMockApp() as unknown as App;
		await persistToolApprovalRules(app, ['Read(/some/path/**)']);
		const raw = await readVaultFile(app, '_synapse/settings.json');
		const parsed = parseSettingsFile(raw);
		expect(parsed.permissions?.allow).toEqual(['Read(/some/path/**)']);
	});

	it('is a no-op when given an empty rule list', async () => {
		const app = createMockApp() as unknown as App;
		await persistToolApprovalRules(app, []);
		expect(app.vault.getAbstractFileByPath('_synapse/settings.json')).toBeNull();
	});

	it('unions new rules into an existing allow list without duplicating', async () => {
		const app = createMockApp() as unknown as App;
		seedFile(app, '_synapse/settings.json', JSON.stringify({
			permissions: {allow: ['Bash(git status)']},
		}));
		await persistToolApprovalRules(app, ['Bash(git status)', 'Read(/foo/**)']);
		const raw = await readVaultFile(app, '_synapse/settings.json');
		const parsed = parseSettingsFile(raw);
		expect(parsed.permissions?.allow?.slice().sort()).toEqual(['Bash(git status)', 'Read(/foo/**)']);
	});

	it('preserves every other top-level key and every other permissions key in an existing file', async () => {
		const app = createMockApp() as unknown as App;
		seedFile(app, '_synapse/settings.json', JSON.stringify({
			$schema: 'https://example.com/schema.json',
			model: 'sonnet',
			permissions: {allow: ['Bash(git status)'], deny: ['Bash(rm -rf /)'], defaultMode: 'default'},
		}));
		await persistToolApprovalRules(app, ['Read(/foo/**)']);
		const raw = await readVaultFile(app, '_synapse/settings.json');
		const parsed = parseSettingsFile(raw);
		expect(parsed.$schema).toBe('https://example.com/schema.json');
		expect(parsed.model).toBe('sonnet');
		expect(parsed.permissions?.deny).toEqual(['Bash(rm -rf /)']);
		expect(parsed.permissions?.defaultMode).toBe('default');
		expect(parsed.permissions?.allow?.slice().sort()).toEqual(['Bash(git status)', 'Read(/foo/**)']);
	});

	it('throws and does not overwrite when the existing file is malformed JSON', async () => {
		const app = createMockApp() as unknown as App;
		seedFile(app, '_synapse/settings.json', '{ not valid json');
		await expect(persistToolApprovalRules(app, ['Read(/foo/**)'])).rejects.toThrow('not valid JSON');
		const raw = await readVaultFile(app, '_synapse/settings.json');
		expect(raw).toBe('{ not valid json');
	});
});

// ---------------------------------------------------------------------------
// ensureImproveSynapseSkill
// ---------------------------------------------------------------------------

describe('ensureImproveSynapseSkill', () => {
	it('seeds the skill when absent and returns its path', async () => {
		const app = createMockApp() as unknown as App;
		const path = await ensureImproveSynapseSkill(app);
		expect(path).toBe(`_synapse/skills/${IMPROVE_SYNAPSE_SKILL_NAME}/SKILL.md`);
		expect(app.vault.getAbstractFileByPath(path!)).not.toBeNull();
	});

	it('returns null and does not overwrite when the skill already exists', async () => {
		const app = createMockApp() as unknown as App;
		await ensureImproveSynapseSkill(app);
		const result = await ensureImproveSynapseSkill(app);
		expect(result).toBeNull();
	});
});
