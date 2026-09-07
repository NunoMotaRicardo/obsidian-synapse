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
		expect(decision.clearPending).toBe(false);
	});

	it('applies the change immediately when no conversation is in progress', () => {
		const decision = decideWorkingDirAutoUpdate({
			newDir: 'ProjectB',
			currentWorkingDir: 'ProjectA',
			conversationInProgress: false,
		});

		expect(decision.applyNow).toBe(true);
		expect(decision.pendingDir).toBe(null);
		expect(decision.clearPending).toBe(true);
	});

	it('is a no-op when the folder has not actually changed while idle, and clears any pending deferral', () => {
		const idle = decideWorkingDirAutoUpdate({
			newDir: 'ProjectA',
			currentWorkingDir: 'ProjectA',
			conversationInProgress: false,
		});

		expect(idle).toEqual({applyNow: false, pendingDir: null, clearPending: true});
	});

	it('cancels a pending deferral when the note returns to the current working directory mid-conversation', () => {
		// Regression test for the "stale pendingWorkingDir" bug: returning to the folder the
		// session is already in must not leave an earlier detour's deferral in place, since
		// nothing else clears it and `newConversation()` would otherwise apply it later even
		// though the user is looking at a note back in the original folder.
		const midConversation = decideWorkingDirAutoUpdate({
			newDir: 'ProjectA',
			currentWorkingDir: 'ProjectA',
			conversationInProgress: true,
		});

		expect(midConversation).toEqual({applyNow: false, pendingDir: null, clearPending: true});
	});

	it('full scenario: switch away (deferred), switch back (cancelled), end conversation applies nothing extra', () => {
		// 1. Working directory is ProjectA; a conversation is in progress.
		let workingDir = 'ProjectA';
		let pendingWorkingDir: string | null = null;
		const conversationInProgress = true;

		// 2. User opens a note in ProjectB -> deferred.
		let decision = decideWorkingDirAutoUpdate({newDir: 'ProjectB', currentWorkingDir: workingDir, conversationInProgress});
		if (decision.applyNow) workingDir = 'ProjectB';
		if (decision.pendingDir !== null) pendingWorkingDir = decision.pendingDir;
		else if (decision.clearPending) pendingWorkingDir = null;
		expect(pendingWorkingDir).toBe('ProjectB');

		// 3. User switches back to a note in ProjectA -> pending deferral must be cancelled.
		decision = decideWorkingDirAutoUpdate({newDir: 'ProjectA', currentWorkingDir: workingDir, conversationInProgress});
		if (decision.applyNow) workingDir = 'ProjectA';
		if (decision.pendingDir !== null) pendingWorkingDir = decision.pendingDir;
		else if (decision.clearPending) pendingWorkingDir = null;
		expect(pendingWorkingDir).toBe(null);

		// 4. User ends the conversation -> newConversation() applies any pending dir (none left).
		if (pendingWorkingDir !== null) {
			workingDir = pendingWorkingDir;
			pendingWorkingDir = null;
		}

		expect(workingDir).toBe('ProjectA');
		expect(pendingWorkingDir).toBe(null);
	});
});
