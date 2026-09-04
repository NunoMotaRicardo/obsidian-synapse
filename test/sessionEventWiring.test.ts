import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// ---------------------------------------------------------------------------
// SessionEvent delivery wiring
//
// `SessionEvent.type` is `string`, not a union of literals, so TypeScript
// cannot check that an event the service dispatches is one the view listens
// for. And `Session.dispatch()` fans out only to handlers registered for that
// exact type — `ensureSession()`'s `onEvent` callback buffers events until
// `registerSessionEvents()` runs and drops everything after that, so
// `registerSessionEvents()`'s list is the only live delivery path.
//
// The two facts combine badly: an event type missing from that list is never
// handled, at runtime, with no error and no failing test. That is exactly how
// #130's `session.metadata` shipped dead — dispatched every turn, listened for
// nowhere, so the context gauge could never appear.
//
// This test reads both sources and asserts the containment directly. It is a
// source-level check rather than a behavioural one because the gap it guards
// is a wiring gap: any test that constructs a Session and a view would have to
// know the event type to assert on, which is the very thing being forgotten.
// ---------------------------------------------------------------------------

const repoRoot = resolve(__dirname, '..');

function read(relativePath: string): string {
	return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

/** Event-type string literals the service produces, from `type: '<domain>.<name>'`. */
function dispatchedEventTypes(): Set<string> {
	const source = read('src/agentService.ts');
	const matches = source.matchAll(/type: '([a-z][a-z_]*\.[a-z_]+)'/g);
	return new Set(Array.from(matches, m => m[1]!));
}

/** Event types the chat view subscribes to, from `session.on('<type>'`. */
function registeredEventTypes(): Set<string> {
	const source = read('src/synapseView.ts');
	const matches = source.matchAll(/session\.on\('([^']+)'/g);
	return new Set(Array.from(matches, m => m[1]!));
}

describe('SessionEvent wiring', () => {
	it('finds event types in both sources (guards the regexes themselves)', () => {
		// If a refactor changes how events are written, these regexes could silently
		// match nothing and the containment assertion below would pass vacuously.
		expect(dispatchedEventTypes().size).toBeGreaterThan(5);
		expect(registeredEventTypes().size).toBeGreaterThan(5);
	});

	it('registers a handler for every event type the service dispatches', () => {
		const registered = registeredEventTypes();
		const unhandled = [...dispatchedEventTypes()].filter(t => !registered.has(t)).sort();
		expect(
			unhandled,
			`These SessionEvent types are dispatched by src/agentService.ts but have no `
			+ `session.on(...) handler in registerSessionEvents() (src/synapseView.ts), so they `
			+ `are silently dropped at runtime: ${unhandled.join(', ')}`,
		).toEqual([]);
	});

	it('still dispatches and handles session.metadata (the #130 regression)', () => {
		expect(dispatchedEventTypes()).toContain('session.metadata');
		expect(registeredEventTypes()).toContain('session.metadata');
	});
});
