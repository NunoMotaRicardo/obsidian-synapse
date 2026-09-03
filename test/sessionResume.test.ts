import {describe, it, expect} from 'vitest';
import {resolveResumeSessionId} from '../src/agentService';

// ---------------------------------------------------------------------------
// resolveResumeSessionId (issue #104)
//
// ensureSession() (synapseView.ts) tears down `currentSession` and rebuilds a
// fresh `Session` whenever `configDirty` is set (e.g. model/reasoning/agent
// change). The new `Session` object always starts with an empty `_sessionId`
// — there is no seeding path for it directly. Without carrying the prior
// conversation's id through as `SessionConfig.resume`, `send()` silently
// omits `resume` and the conversation is lost on every config change.
//
// The fix seeds the rebuilt `SessionConfig` with `resume: <prior sessionId>`
// (buildSessionConfig()'s `opts.resume`), and `Session.send()` resolves the
// effective resume id via `resolveResumeSessionId()`: the session's own
// captured id takes priority once it has one, otherwise the config-seeded id
// carries the conversation across the rebuild.
// ---------------------------------------------------------------------------

describe('resolveResumeSessionId', () => {
	it('carries the prior conversation id through config.resume when the session has never sent a message', () => {
		// This is exactly the state of a freshly rebuilt Session right after a
		// configDirty rebuild: _sessionId is '', but the rebuilt SessionConfig
		// was seeded with the outgoing session's id.
		expect(resolveResumeSessionId('', 'prior-session-abc')).toBe('prior-session-abc');
	});

	it('prefers the session\'s own captured sessionId once it has streamed a message', () => {
		// After the rebuilt session's first send() streams a message, `_sessionId`
		// is captured from the SDK and should take priority over whatever the
		// config was seeded with (the SDK's own id is authoritative).
		expect(resolveResumeSessionId('captured-session-id', 'prior-session-abc')).toBe('captured-session-id');
	});

	it('returns undefined when neither the session nor the config has an id', () => {
		// A genuinely brand-new session (never resumed, never sent a message) —
		// `resume` should be omitted entirely, not sent as an empty string.
		expect(resolveResumeSessionId('', undefined)).toBeUndefined();
	});

	it('returns undefined when both are empty strings', () => {
		expect(resolveResumeSessionId('', '')).toBeUndefined();
	});
});
