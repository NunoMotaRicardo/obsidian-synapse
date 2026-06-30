import {describe, it, expect, vi} from 'vitest'
import {matchGlob, matchCron} from '../src/triggers'

// ---------------------------------------------------------------------------
// matchGlob
// ---------------------------------------------------------------------------

describe('matchGlob', () => {
	it('exact match returns true', () => {
		expect(matchGlob('inbox/note.md', 'inbox/note.md')).toBe(true)
	})

	it('exact match — different path returns false', () => {
		expect(matchGlob('inbox/note.md', 'inbox/other.md')).toBe(false)
	})

	it('* wildcard matches within single segment', () => {
		expect(matchGlob('inbox/*.md', 'inbox/note.md')).toBe(true)
	})

	it('* wildcard does not cross directory boundaries', () => {
		expect(matchGlob('inbox/*.md', 'inbox/sub/note.md')).toBe(false)
	})

	it('** wildcard matches nested path segments', () => {
		expect(matchGlob('projects/**/notes.md', 'projects/a/b/notes.md')).toBe(true)
	})

	it('** wildcard matches single segment too', () => {
		expect(matchGlob('projects/**/notes.md', 'projects/a/notes.md')).toBe(true)
	})

	it('prefix match (pattern ending with /) matches files under that prefix', () => {
		expect(matchGlob('inbox/', 'inbox/note.md')).toBe(true)
	})

	it('prefix match does not match files in sibling folders', () => {
		expect(matchGlob('inbox/', 'archive/note.md')).toBe(false)
	})

	it('empty pattern matches any path', () => {
		expect(matchGlob('', 'anything.md')).toBe(true)
	})

	it('no match returns false', () => {
		expect(matchGlob('archive/*.md', 'inbox/note.md')).toBe(false)
	})

	it('*.md matches top-level markdown files', () => {
		expect(matchGlob('*.md', 'note.md')).toBe(true)
	})

	it('*.md does not match nested markdown files', () => {
		expect(matchGlob('*.md', 'inbox/note.md')).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// matchCron
// ---------------------------------------------------------------------------

describe('matchCron', () => {
	it('* * * * * matches any date', () => {
		expect(matchCron('* * * * *', new Date('2024-01-15T09:37:00'))).toBe(true)
	})

	it('0 9 * * * matches 09:00', () => {
		expect(matchCron('0 9 * * *', new Date('2024-01-15T09:00:00'))).toBe(true)
	})

	it('0 9 * * * does not match 09:01', () => {
		expect(matchCron('0 9 * * *', new Date('2024-01-15T09:01:00'))).toBe(false)
	})

	it('*/15 * * * * matches minute 0', () => {
		const d = new Date('2024-01-15T10:00:00')
		expect(matchCron('*/15 * * * *', d)).toBe(true)
	})

	it('*/15 * * * * matches minute 15', () => {
		const d = new Date('2024-01-15T10:15:00')
		expect(matchCron('*/15 * * * *', d)).toBe(true)
	})

	it('*/15 * * * * matches minute 30', () => {
		const d = new Date('2024-01-15T10:30:00')
		expect(matchCron('*/15 * * * *', d)).toBe(true)
	})

	it('*/15 * * * * matches minute 45', () => {
		const d = new Date('2024-01-15T10:45:00')
		expect(matchCron('*/15 * * * *', d)).toBe(true)
	})

	it('*/15 * * * * does not match minute 7', () => {
		const d = new Date('2024-01-15T10:07:00')
		expect(matchCron('*/15 * * * *', d)).toBe(false)
	})

	it('0 8-10 * * * matches hour 9', () => {
		expect(matchCron('0 8-10 * * *', new Date('2024-01-15T09:00:00'))).toBe(true)
	})

	it('0 8-10 * * * does not match hour 11', () => {
		expect(matchCron('0 8-10 * * *', new Date('2024-01-15T11:00:00'))).toBe(false)
	})

	it('0 0 * * 1 matches a Monday', () => {
		// 2024-01-15 is a Monday
		const monday = new Date('2024-01-15T00:00:00')
		expect(monday.getDay()).toBe(1) // verify it is indeed Monday
		expect(matchCron('0 0 * * 1', monday)).toBe(true)
	})

	it('0 0 * * 1 does not match a Tuesday', () => {
		// 2024-01-16 is a Tuesday
		const tuesday = new Date('2024-01-16T00:00:00')
		expect(tuesday.getDay()).toBe(2)
		expect(matchCron('0 0 * * 1', tuesday)).toBe(false)
	})

	it('invalid expression (wrong field count) returns false and logs a warning', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		expect(matchCron('* * *', new Date())).toBe(false)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('5 fields'))
		warn.mockRestore()
	})

	it('comma-separated list in minute field matches any listed minute', () => {
		expect(matchCron('0,30 * * * *', new Date('2024-01-15T10:30:00'))).toBe(true)
		expect(matchCron('0,30 * * * *', new Date('2024-01-15T10:15:00'))).toBe(false)
	})
})
