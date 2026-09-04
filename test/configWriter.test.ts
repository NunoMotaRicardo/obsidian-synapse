import {describe, it, expect} from 'vitest';
import type {App} from 'obsidian';
import {
	parseFrontmatter,
	ensureFolder,
	writeAgent,
	writeTrigger,
	writeSkill,
	modifyArtifact,
	deleteArtifact,
	scanVaultStructure,
	scanAgents,
	scanTriggers,
	ensureImproveSynapseSkill,
	IMPROVE_SYNAPSE_SKILL_NAME,
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

	it('round-trips a value written by writeAgent through serializeFmField/buildMarkdown', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'My Agent',
			description: 'Handles: research and citations',
			instructions: 'Be helpful.',
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
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'Padded',
			description: '  padded value  ',
			instructions: '',
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
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'Quote Value',
			description: original,
			instructions: '',
		});
		const raw = await readVaultFile(app, path);
		const {meta} = parseFrontmatter(raw);
		expect(meta['description']).toBe(original);
	});

	it('round-trips a value containing backslashes', async () => {
		const app = createMockApp() as unknown as App;
		// The colon is what triggers quoting/escaping for this value.
		const original = 'C:\\Users\\me: path';
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'Backslash Value',
			description: original,
			instructions: '',
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
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'Backslash Before Quote',
			description: original,
			instructions: '',
		});
		const raw = await readVaultFile(app, path);
		const {meta} = parseFrontmatter(raw);
		expect(meta['description']).toBe(original);
	});

	it('leaves an unquoted value containing a backslash unchanged (no colon/quote/newline to trigger escaping)', async () => {
		const app = createMockApp() as unknown as App;
		const original = 'Users\\me\\docs';
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'Plain Backslash',
			description: original,
			instructions: '',
		});
		const raw = await readVaultFile(app, path);
		// Confirm it was written unquoted (the case that was already correct and must not regress).
		expect(raw).toContain(`description: ${original}`);
		const {meta} = parseFrontmatter(raw);
		expect(meta['description']).toBe(original);
	});

	it('keeps a quoted+escaped value byte-identical across writeAgent and repeated modifyArtifact cycles', async () => {
		const app = createMockApp() as unknown as App;
		const original = 'C:\\Users\\me: path with "quotes"';
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'Cycle Value',
			description: original,
			instructions: '',
		});

		for (let i = 0; i < 4; i++) {
			await modifyArtifact(app, path, {description: original});
			const raw = await readVaultFile(app, path);
			const {meta} = parseFrontmatter(raw);
			expect(meta['description']).toBe(original);
		}
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
// writeAgent / writeTrigger / writeSkill — kebab naming, folder creation
// ---------------------------------------------------------------------------

describe('writeAgent', () => {
	it('writes a kebab-case filename under the given folder', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'Academic Research',
			description: 'desc',
			instructions: 'instr',
		});
		expect(path).toBe('_synapse/agents/academic-research.md');
	});

	it('omits undefined optional fields from the written frontmatter', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'Minimal',
			description: 'desc',
			instructions: 'instr',
		});
		const raw = await readVaultFile(app, path);
		expect(raw).not.toContain('model:');
		expect(raw).not.toContain('tools:');
	});

	it('serializes list fields (tools/skills) as YAML lists', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'Tooled',
			description: 'desc',
			instructions: 'instr',
			tools: ['Read', 'Write'],
		});
		const raw = await readVaultFile(app, path);
		const {meta} = parseFrontmatter(raw);
		expect(meta['tools']).toEqual(['Read', 'Write']);
	});
});

describe('writeTrigger', () => {
	it('serializes the write field as the string "true" only when write === true', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeTrigger(app, '_synapse/triggers', {
			name: 'My Trigger',
			description: 'desc',
			event: 'file-created',
			body: 'do stuff',
			write: true,
			enabled: true,
		});
		const raw = await readVaultFile(app, path);
		const {meta} = parseFrontmatter(raw);
		expect(meta['write']).toBe('true');
	});

	it('serializes write: "frontmatter" verbatim', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeTrigger(app, '_synapse/triggers', {
			name: 'FM Trigger',
			description: 'desc',
			event: 'file-created',
			body: 'do stuff',
			write: 'frontmatter',
			enabled: true,
		});
		const raw = await readVaultFile(app, path);
		const {meta} = parseFrontmatter(raw);
		expect(meta['write']).toBe('frontmatter');
	});

	it('omits the write field entirely when write === false (the default)', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeTrigger(app, '_synapse/triggers', {
			name: 'Default Trigger',
			description: 'desc',
			event: 'file-created',
			body: 'do stuff',
			write: false,
			enabled: true,
		});
		const raw = await readVaultFile(app, path);
		expect(raw).not.toContain('write:');
	});

	it('only serializes enabled: "false" when disabled (omits the field when enabled)', async () => {
		const app = createMockApp() as unknown as App;
		const enabledPath = await writeTrigger(app, '_synapse/triggers', {
			name: 'Enabled', description: 'd', event: 'file-created', body: 'b', write: false, enabled: true,
		});
		const disabledPath = await writeTrigger(app, '_synapse/triggers', {
			name: 'Disabled', description: 'd', event: 'file-created', body: 'b', write: false, enabled: false,
		});
		const enabledRaw = await readVaultFile(app, enabledPath);
		const disabledRaw = await readVaultFile(app, disabledPath);
		expect(enabledRaw).not.toContain('enabled:');
		expect(disabledRaw).toContain('enabled: false');
	});
});

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
// modifyArtifact
// ---------------------------------------------------------------------------

describe('modifyArtifact', () => {
	it('merges updates into existing frontmatter, preserving untouched fields', async () => {
		// writeTrigger (unlike writeAgent) persists `name` in frontmatter, so it's
		// a good vehicle for asserting an untouched field survives the merge.
		const app = createMockApp() as unknown as App;
		const path = await writeTrigger(app, '_synapse/triggers', {
			name: 'Merge Test',
			description: 'original description',
			event: 'file-created',
			body: 'body text',
			write: false,
			enabled: true,
		});
		await modifyArtifact(app, path, {description: 'updated description'});
		const raw = await readVaultFile(app, path);
		const {meta, body} = parseFrontmatter(raw);
		expect(meta['description']).toBe('updated description');
		expect(meta['name']).toBe('Merge Test');
		expect(body.trim()).toBe('body text');
	});

	it('removes a key when the update value is undefined', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'Removable',
			description: 'desc',
			instructions: '',
			model: 'sonnet',
		});
		await modifyArtifact(app, path, {model: undefined});
		const raw = await readVaultFile(app, path);
		expect(raw).not.toContain('model:');
	});

	it('replaces the body when updates.body is provided', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'Body Swap',
			description: 'desc',
			instructions: 'old body',
		});
		await modifyArtifact(app, path, {body: 'new body'});
		const raw = await readVaultFile(app, path);
		const {body} = parseFrontmatter(raw);
		// buildMarkdown wraps the body in a leading/trailing newline; callers
		// throughout the codebase (scanAgents/scanTriggers) always `.trim()` it.
		expect(body.trim()).toBe('new body');
	});

	it('throws when the target file does not exist', async () => {
		const app = createMockApp() as unknown as App;
		await expect(modifyArtifact(app, '_synapse/agents/missing.md', {description: 'x'}))
			.rejects.toThrow('Artifact not found');
	});
});

// ---------------------------------------------------------------------------
// deleteArtifact
// ---------------------------------------------------------------------------

describe('deleteArtifact', () => {
	it('trashes an existing artifact file', async () => {
		const app = createMockApp() as unknown as App;
		const path = await writeAgent(app, '_synapse/agents', {
			name: 'Doomed', description: 'd', instructions: '',
		});
		await deleteArtifact(app, path);
		expect(app.vault.getAbstractFileByPath(path)).toBeNull();
	});

	it('throws when the target file does not exist', async () => {
		const app = createMockApp() as unknown as App;
		await expect(deleteArtifact(app, '_synapse/agents/missing.md')).rejects.toThrow('Artifact not found');
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
// scanAgents / scanTriggers — read side of the round trip
// ---------------------------------------------------------------------------

describe('scanAgents', () => {
	it('returns [] when the folder does not exist', async () => {
		const app = createMockApp() as unknown as App;
		expect(await scanAgents(app, '_synapse/agents')).toEqual([]);
	});

	it('reads back an agent written by writeAgent, including tools/skills lists', async () => {
		// writeAgent does not persist `name` in frontmatter (only `description`,
		// `model`, `tools`, `skills`) — scanAgents falls back to the kebab-case
		// filename derived from the write, so the read-back name is the slug,
		// not the original display name passed to writeAgent.
		const app = createMockApp() as unknown as App;
		await writeAgent(app, '_synapse/agents', {
			name: 'Round Trip',
			description: 'desc',
			instructions: 'Body content.',
			tools: ['Read', 'Write'],
		});
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

describe('scanTriggers', () => {
	it('skips a trigger with both event and schedule set (mutually exclusive)', async () => {
		const app = createMockApp() as unknown as App;
		seedFolder(app, '_synapse/triggers');
		seedFile(app, '_synapse/triggers/bad.md', '---\nname: bad\nevent: file-created\nschedule: "0 9 * * *"\n---\nbody');
		const triggers = await scanTriggers(app, '_synapse/triggers');
		expect(triggers).toEqual([]);
	});

	it('skips a trigger with an invalid event value', async () => {
		const app = createMockApp() as unknown as App;
		seedFolder(app, '_synapse/triggers');
		seedFile(app, '_synapse/triggers/bad.md', '---\nname: bad\nevent: file-teleported\n---\nbody');
		const triggers = await scanTriggers(app, '_synapse/triggers');
		expect(triggers).toEqual([]);
	});

	it('defaults enabled to true when omitted, and honors enabled: false', async () => {
		const app = createMockApp() as unknown as App;
		await writeTrigger(app, '_synapse/triggers', {
			name: 'Default Enabled', description: 'd', event: 'file-created', body: 'b', write: false, enabled: true,
		});
		await writeTrigger(app, '_synapse/triggers', {
			name: 'Explicitly Disabled', description: 'd', event: 'file-created', body: 'b', write: false, enabled: false,
		});
		const triggers = await scanTriggers(app, '_synapse/triggers');
		const byName = Object.fromEntries(triggers.map(t => [t.name, t]));
		expect(byName['Default Enabled']?.enabled).toBe(true);
		expect(byName['Explicitly Disabled']?.enabled).toBe(false);
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
