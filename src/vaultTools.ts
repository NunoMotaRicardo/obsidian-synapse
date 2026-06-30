import {App, normalizePath, TFile} from 'obsidian';
import {matchGlob} from './triggers';
import type {LocalTool} from './providerModels';

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
