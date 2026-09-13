import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// ---------------------------------------------------------------------------
// Reviewer-flagged HIGH regression fix: `restoreFromBackground()` used to call
// `bg.detach()` *before* awaiting the history render, then only called
// `registerSessionEvents()` afterwards — leaving a window where neither `bg`
// (detached) nor the foreground `handleSessionEvent()` (not yet registered)
// was listening to the `Session`, silently dropping any SDK event that
// arrived in that gap (a final delta, a `tool.execution_complete`, or the
// terminal `session.idle`/`session.error`).
//
// The fix keeps `bg` attached through every `await` in the history-render
// path, then does `bg.detach()` immediately followed — with zero `await` in
// between — by `registerSessionEvents()`, so exactly one listener (`bg`, then
// the foreground handlers) is registered at every point in time. This is a
// structural regression guard on that ordering, expressed as a source-level
// assertion (same convention as `test/editorialSidebarSearch.test.ts`) since
// `SessionSidebarController`/`SynapseView` have no existing unit-test harness
// (they're `ItemView` subclasses tightly coupled to live Obsidian DOM/SDK
// wiring) to exercise the real control flow end-to-end.
// ---------------------------------------------------------------------------

const source = readFileSync(resolve(__dirname, '..', 'src/view/sessionSidebar.ts'), 'utf8');

/** Extract a method's `{ ... }` body (brace-depth matched) by its declaration signature. */
function extractMethodBody(signature: string): string {
	const start = source.indexOf(signature);
	expect(start).toBeGreaterThan(-1);
	let i = source.indexOf('{', start);
	expect(i).toBeGreaterThan(-1);
	const bodyStart = i;
	let depth = 0;
	do {
		const ch = source.charAt(i);
		if (ch === '{') depth++;
		else if (ch === '}') depth--;
		i++;
	} while (depth > 0 && i < source.length);
	return source.slice(bodyStart, i);
}

describe('restoreFromBackground — no listener-gap window (HIGH regression fix)', () => {
	const body = extractMethodBody('async restoreFromBackground(bg: BackgroundSession): Promise<void> {');

	it('detaches the background listener and registers foreground events with zero `await` in between', () => {
		const detachIdx = body.indexOf('bg.detach();');
		const registerIdx = body.indexOf('this.view.view.registerSessionEvents();');
		expect(detachIdx).toBeGreaterThan(-1);
		expect(registerIdx).toBeGreaterThan(detachIdx);

		const between = body.slice(detachIdx, registerIdx);
		expect(between).not.toContain('await ');
	});

	it('keeps `bg` attached through the history-render awaits — detach happens after, not before, them', () => {
		const firstRenderAwaitIdx = body.indexOf('await Promise.all(renderPromises)');
		const detachIdx = body.indexOf('bg.detach();');
		expect(firstRenderAwaitIdx).toBeGreaterThan(-1);
		expect(detachIdx).toBeGreaterThan(firstRenderAwaitIdx);
	});

	it('re-renders any message(s) bg pushed while history was rendering, before switching ownership', () => {
		const catchUpLoopIdx = body.indexOf('while (renderedCount < bg.messages.length)');
		const detachIdx = body.indexOf('bg.detach();');
		expect(catchUpLoopIdx).toBeGreaterThan(-1);
		expect(catchUpLoopIdx).toBeLessThan(detachIdx);
	});

	it('reads every view-adopted field from `bg` only after `bg.detach()` (not a pre-render stale snapshot)', () => {
		const detachIdx = body.indexOf('bg.detach();');
		// A representative sample of fields the view adopts from `bg` — each occurrence
		// must be after `bg.detach()`, not before it (the pre-fix ordering read them
		// before the render awaits, which could observe stale values).
		for (const fieldRead of [
			'this.view.view.isStreaming = bg.isStreaming;',
			'this.view.view.streamingContent = bg.streamingContent;',
			'this.view.view.turnUsage = bg.turnUsage;',
			'this.view.view.taskPlanTracker.restore(bg.taskPlanTracker.snapshot());',
		]) {
			const idx = body.indexOf(fieldRead);
			expect(idx).toBeGreaterThan(detachIdx);
		}
	});
});
