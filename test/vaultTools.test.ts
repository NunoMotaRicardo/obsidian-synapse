import {describe, it, expect} from 'vitest';
import {matchGlob} from '../src/vaultTools';

// ---------------------------------------------------------------------------
// matchGlob — used by the `list_notes` vault tool's optional glob filter.
// Moved here from the trigger system (removed in #188), which was its only
// other consumer; these cases carried over unchanged.
// ---------------------------------------------------------------------------

describe('matchGlob', () => {
	it('exact match returns true', () => {
		expect(matchGlob('inbox/note.md', 'inbox/note.md')).toBe(true);
	});

	it('exact match — different path returns false', () => {
		expect(matchGlob('inbox/note.md', 'inbox/other.md')).toBe(false);
	});

	it('* wildcard matches within single segment', () => {
		expect(matchGlob('inbox/*.md', 'inbox/note.md')).toBe(true);
	});

	it('* wildcard does not cross directory boundaries', () => {
		expect(matchGlob('inbox/*.md', 'inbox/sub/note.md')).toBe(false);
	});

	it('** wildcard matches nested path segments', () => {
		expect(matchGlob('projects/**/notes.md', 'projects/a/b/notes.md')).toBe(true);
	});

	it('** wildcard matches single segment too', () => {
		expect(matchGlob('projects/**/notes.md', 'projects/a/notes.md')).toBe(true);
	});

	it('prefix match (pattern ending with /) matches files under that prefix', () => {
		expect(matchGlob('inbox/', 'inbox/note.md')).toBe(true);
	});

	it('prefix match does not match files in sibling folders', () => {
		expect(matchGlob('inbox/', 'archive/note.md')).toBe(false);
	});

	it('empty pattern matches any path', () => {
		expect(matchGlob('', 'anything.md')).toBe(true);
	});

	it('no match returns false', () => {
		expect(matchGlob('archive/*.md', 'inbox/note.md')).toBe(false);
	});

	it('*.md matches top-level markdown files', () => {
		expect(matchGlob('*.md', 'note.md')).toBe(true);
	});

	it('*.md does not match nested markdown files', () => {
		expect(matchGlob('*.md', 'inbox/note.md')).toBe(false);
	});
});
