import {describe, it, expect} from 'vitest';
import {decideWorkingDirAutoUpdate} from '../src/view/sessionConfig';

// ---------------------------------------------------------------------------
// decideWorkingDirAutoUpdate (issue #108 / #93 / #131)
//
// `autoUpdateWorkingDirectory` (default true) makes `updateActiveNote()` (inputArea.ts)
// set `workingDir`/`configDirty` whenever the active note switches to a different folder,
// even mid-conversation. Before #104, that forced a `Session` rebuild whose `_sessionId`
// started empty, silently dropping conversation history (the likely root cause of #93) —
// so the change was deferred until the conversation ended. #104 fixed the rebuild to carry
// `resume` forward, and #131 verified (empirically, against a real CLI session) that
// resuming under a changed `cwd` does not degrade path handling either. With no surviving
// justification for deferring, the change now always applies immediately: this function is
// just "did the folder actually change".
// ---------------------------------------------------------------------------

describe('decideWorkingDirAutoUpdate', () => {
	it('applies the change when the active note moved to a different folder', () => {
		expect(decideWorkingDirAutoUpdate({newDir: 'ProjectB', currentWorkingDir: 'ProjectA'})).toBe(true);
	});

	it('applies the change even while a conversation would be considered in progress', () => {
		// There is no conversationInProgress parameter anymore — the decision no longer
		// depends on it. This test exists so a future re-introduction of that parameter
		// doesn't silently reintroduce the deferral without a deliberate decision.
		expect(decideWorkingDirAutoUpdate({newDir: 'ProjectB', currentWorkingDir: 'ProjectA'})).toBe(true);
	});

	it('is a no-op when the folder has not actually changed', () => {
		expect(decideWorkingDirAutoUpdate({newDir: 'ProjectA', currentWorkingDir: 'ProjectA'})).toBe(false);
	});
});
