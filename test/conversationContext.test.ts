import {describe, it, expect} from 'vitest';
import {upsertSessionContext, resolveConversationContext} from '../src/view/sessionConfig';
import type {ConversationContext} from '../src/types';

// ---------------------------------------------------------------------------
// Per-conversation context (working directory, context note, scope)
//
// Persisted per SDK session id (SynapseSettings.sessionContexts) so reopening a
// conversation from the sidebar restores the context it was left in, instead of
// whatever the view happens to hold.
// ---------------------------------------------------------------------------

const ctx = (workingDir: string, notePath: string | null = null, scopePaths: string[] = []): ConversationContext =>
	({workingDir, notePath, scopePaths});

describe('upsertSessionContext', () => {
	it('adds a new entry to an undefined map', () => {
		expect(upsertSessionContext(undefined, 's1', ctx('Projects', 'Projects/a.md'))).toEqual({
			s1: ctx('Projects', 'Projects/a.md'),
		});
	});

	it('does not mutate the input map or alias the scope array', () => {
		const scope = ['Projects'];
		const input = {s1: ctx('')};
		const result = upsertSessionContext(input, 's2', ctx('', null, scope));
		expect(input).toEqual({s1: ctx('')});
		scope.push('Other');
		expect(result.s2?.scopePaths).toEqual(['Projects']);
	});

	it('evicts the least-recently-touched entries past the cap', () => {
		let map = upsertSessionContext(undefined, 'a', ctx('A'), 2);
		map = upsertSessionContext(map, 'b', ctx('B'), 2);
		map = upsertSessionContext(map, 'a', ctx('A2'), 2); // re-touch moves 'a' to the end
		map = upsertSessionContext(map, 'c', ctx('C'), 2);
		expect(Object.keys(map)).toEqual(['a', 'c']);
		expect(map.a?.workingDir).toBe('A2');
	});
});

describe('resolveConversationContext', () => {
	it('prefers the saved context', () => {
		const saved = ctx('Projects', 'Projects/a.md', ['/']);
		expect(resolveConversationContext(saved, 'D:/vault/Other', 'D:/vault')).toEqual(saved);
	});

	it('falls back to the session cwd, vault-relative, with no note or scope', () => {
		expect(resolveConversationContext(undefined, 'D:\\vault\\Projects\\Sub', 'D:\\vault')).toEqual(ctx('Projects/Sub'));
	});

	it('compares Windows paths case-insensitively', () => {
		expect(resolveConversationContext(undefined, 'd:/Vault/Projects', 'D:/vault').workingDir).toBe('Projects');
	});

	it('falls back to the vault root for the root itself, outside paths, and a missing cwd', () => {
		expect(resolveConversationContext(undefined, 'D:/vault', 'D:/vault').workingDir).toBe('');
		expect(resolveConversationContext(undefined, 'D:/vault-other/x', 'D:/vault').workingDir).toBe('');
		expect(resolveConversationContext(undefined, undefined, 'D:/vault').workingDir).toBe('');
	});
});
