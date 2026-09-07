import {describe, it, expect} from 'vitest';
import {decideWorkingDirAutoUpdate} from '../src/view/sessionConfig';

// ---------------------------------------------------------------------------
// decideWorkingDirAutoUpdate (issue #108 / #93 / #131 / #202)
//
// `autoUpdateWorkingDirectory` (default true) makes `updateActiveNote()` (inputArea.ts)
// want to set `workingDir`/`configDirty` whenever the active note switches to a different
// folder, even mid-conversation. Doing so immediately makes `ensureSession()` tear down
// the live `Session` and rebuild it, resuming by id — a **new CLI process that replays the
// whole transcript**, re-writing the entire conversation to the prompt cache. Users switch
// notes constantly *between* turns, so an immediate-apply policy pays that cost on a large
// share of follow-up messages.
//
// #104 already fixed the transcript-loss bug this deferral was originally built for, and
// #131 verified empirically that resuming under a changed `cwd` does not degrade path
// handling either — neither of those findings is being re-litigated here. The deferral
// returns on a different, narrower ground #131 never weighed: the token cost of the
// rebuild itself. So the change is held in `pendingWorkingDir` while a conversation is in
// progress and applied once it ends (`newConversation()`), matching pre-#131 behavior.
//
// Manual overrides (`SynapseView.setWorkingDir()`, e.g. dragging a folder onto the input
// area) don't call this function at all — they set `workingDir` directly and always apply
// immediately, deferral or not.
// ---------------------------------------------------------------------------

describe('decideWorkingDirAutoUpdate', () => {
	it('does not apply the change immediately when a conversation is already in progress', () => {
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
