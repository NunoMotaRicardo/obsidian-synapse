import {describe, it, expect} from 'vitest';
import {decideWorkingDirAutoUpdate} from '../src/view/sessionConfig';

// ---------------------------------------------------------------------------
// decideWorkingDirAutoUpdate (issue #108 / #93)
//
// Reproduces the bug: `autoUpdateWorkingDirectory` (default true) makes
// `updateActiveNote()` (inputArea.ts) set `configDirty = true` on every active-note
// folder switch, which `ensureSession()` (synapseView.ts) then turns into a full
// session rebuild — discarding the live `Session` and its `_sessionId`, so the next
// `send()` starts a brand-new CLI session with no history. Since users switch notes
// constantly *between* turns, this silently drops conversation context on nearly
// every follow-up message (the likely root cause of #93).
// ---------------------------------------------------------------------------

describe('decideWorkingDirAutoUpdate', () => {
	it('does not apply the change immediately when a conversation is already in progress', () => {
		// Active note switches to a different folder mid-conversation (issue #108
		// repro: send a message, switch to a note in a different folder, send a
		// follow-up). Applying this now would mark configDirty and orphan the
		// session id on the next ensureSession() rebuild.
		const decision = decideWorkingDirAutoUpdate({
			newDir: 'ProjectB',
			currentWorkingDir: 'ProjectA',
			conversationInProgress: true,
		});

		expect(decision.applyNow).toBe(false);
	});

	it('remembers the new directory as pending when deferred', () => {
		const decision = decideWorkingDirAutoUpdate({
			newDir: 'ProjectB',
			currentWorkingDir: 'ProjectA',
			conversationInProgress: true,
		});

		expect(decision.pendingDir).toBe('ProjectB');
	});

	it('applies the change immediately when no conversation is in progress', () => {
		const decision = decideWorkingDirAutoUpdate({
			newDir: 'ProjectB',
			currentWorkingDir: 'ProjectA',
			conversationInProgress: false,
		});

		expect(decision.applyNow).toBe(true);
		expect(decision.pendingDir).toBe(null);
	});

	it('is a no-op when the folder has not actually changed, regardless of conversation state', () => {
		const midConversation = decideWorkingDirAutoUpdate({
			newDir: 'ProjectA',
			currentWorkingDir: 'ProjectA',
			conversationInProgress: true,
		});
		const idle = decideWorkingDirAutoUpdate({
			newDir: 'ProjectA',
			currentWorkingDir: 'ProjectA',
			conversationInProgress: false,
		});

		expect(midConversation).toEqual({applyNow: false, pendingDir: null});
		expect(idle).toEqual({applyNow: false, pendingDir: null});
	});
});
