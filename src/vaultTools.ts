import {App, normalizePath, TFile} from 'obsidian';
import type {LocalTool} from './providerModels';

/* eslint-disable no-irregular-whitespace -- the doc example below has a zero-width
   space between `**` and `/notes` so `**​/` doesn't get parsed as the end of this
   JSDoc comment (`*​/`); it's a deliberate escape, not stray whitespace. */
/**
 * Simple glob matcher for vault-relative paths, used by the `list_notes` tool.
 *
 * Supports:
 * - `*` matches any characters except `/`
 * - `**` matches any path segments (including nested)
 * - Literal path prefixes (e.g. `inbox/` matches `inbox/note.md`)
 * - Combination patterns like `inbox/*.md` or `projects/**​/notes/*.md`
 */
/* eslint-enable no-irregular-whitespace -- re-enable after the doc comment above */
export function matchGlob(pattern: string, path: string): boolean {
	// Normalize both sides: trim, forward slashes, no leading/trailing slash
	const p = pattern.replace(/\\/g, '/').replace(/^\/|\/$/g, '');
	const f = path.replace(/\\/g, '/').replace(/^\/|\/$/g, '');

	// Empty pattern matches everything
	if (!p) return true;

	// Literal prefix match: pattern ending with `/` matches any file under that prefix
	if (pattern.endsWith('/') && !p.includes('*')) {
		return f.startsWith(p + '/') || f === p;
	}

	// Convert glob to regex
	const regexStr = globToRegex(p);
	return new RegExp('^' + regexStr + '$').test(f);
}

/**
 * Convert a glob pattern string to a regex source string.
 * Handles `**`, `*`, and escapes all other regex-special chars.
 */
function globToRegex(pattern: string): string {
	let result = '';
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i]!;
		if (ch === '*') {
			if (pattern[i + 1] === '*') {
				// `**` — match any path segments
				// Consume trailing `/` if present (e.g. `**/`)
				if (pattern[i + 2] === '/') {
					result += '(?:.+/)?';
					i += 3;
				} else {
					result += '.*';
					i += 2;
				}
			} else {
				// `*` — match within a single segment (no `/`)
				result += '[^/]*';
				i += 1;
			}
		} else if (ch === '?') {
			result += '[^/]';
			i += 1;
		} else {
			// Escape regex-special characters
			result += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			i += 1;
		}
	}
	return result;
}

export const vaultTools: LocalTool[] = [
	{
		name: 'read_note',
		description: 'Read the full content of a note/file in the vault given its path.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'The vault-relative path of the file to read (e.g., "folder/note.md").'
				}
			},
			required: ['path']
		},
		execute: async (args: Record<string, unknown>, app: App): Promise<string> => {
			const path = args.path;
			if (typeof path !== 'string' || !path) {
				return 'Error: path parameter must be a non-empty string.';
			}
			const normalized = normalizePath(path);
			const file = app.vault.getAbstractFileByPath(normalized);
			if (file instanceof TFile) {
				return await app.vault.read(file);
			}
			return `Error: File not found at path: ${path}`;
		}
	},
	{
		name: 'list_notes',
		description: 'List all file paths in the vault, optionally filtered by a glob pattern.',
		parameters: {
			type: 'object',
			properties: {
				glob: {
					type: 'string',
					description: 'Optional glob pattern to filter files (e.g. "folder/*.md" or "**.md").'
				}
			}
		},
		execute: async (args: Record<string, unknown>, app: App): Promise<string> => {
			const glob = args.glob;
			const files = app.vault.getFiles();
			let paths = files.map(f => f.path);
			if (typeof glob === 'string' && glob.trim()) {
				paths = paths.filter(p => matchGlob(glob, p));
			}
			return paths.length > 0 ? paths.join('\n') : 'No files found.';
		}
	},
	{
		name: 'search_notes',
		description: 'Search the text content of all markdown notes in the vault for a given string query.',
		parameters: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'The text string to search for in the note bodies.'
				}
			},
			required: ['query']
		},
		execute: async (args: Record<string, unknown>, app: App): Promise<string> => {
			const query = args.query;
			if (typeof query !== 'string' || !query) {
				return 'Error: query parameter must be a non-empty string.';
			}
			const files = app.vault.getMarkdownFiles();
			const results: string[] = [];
			const queryLower = query.toLowerCase();
			for (const file of files) {
				const content = await app.vault.read(file);
				if (content.toLowerCase().includes(queryLower)) {
					const lines = content.split('\n');
					const matchingLines = lines
						.map((line, idx) => line.toLowerCase().includes(queryLower) ? `Line ${idx + 1}: ${line.trim()}` : null)
						.filter((item): item is string => item !== null);
					results.push(`- [[${file.path}]]:\n  ${matchingLines.slice(0, 3).join('\n  ')}`);
				}
			}
			return results.length > 0 ? results.join('\n\n') : 'No matching notes found.';
		}
	}
];
