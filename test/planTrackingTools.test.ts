import {describe, it, expect} from 'vitest';
import {PLAN_TRACKING_TOOLS, mergeAllowedTools} from '../src/agentService';

// ---------------------------------------------------------------------------
// PLAN_TRACKING_TOOLS / mergeAllowedTools (issue #264 AC-1/AC-2)
//
// CLI 2.1.268 made TodoWrite/TaskCreate/TaskGet/TaskUpdate/TaskList default tools only on
// a specific model list; elsewhere (Opus 5.x, Sonnet 5) they must be explicitly listed in
// `allowedTools` or the plan panel never receives a tool call to parse. `allowedTools` only
// auto-allows/enables tools — it doesn't replace the base toolset the way `tools` would — so
// merging in the plan-tracking tools must never drop anything a caller already listed.
// ---------------------------------------------------------------------------

describe('PLAN_TRACKING_TOOLS', () => {
	it('lists both the legacy TodoWrite tool and the TaskCreate/Get/Update/List family', () => {
		expect(PLAN_TRACKING_TOOLS).toEqual(['TodoWrite', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']);
	});
});

describe('mergeAllowedTools', () => {
	it('returns the plan-tracking tools unchanged when nothing else is passed', () => {
		expect(mergeAllowedTools(PLAN_TRACKING_TOOLS)).toEqual(PLAN_TRACKING_TOOLS);
	});

	it('merges an existing allowedTools list with the plan-tracking tools without dropping either', () => {
		const existing = ['Bash', 'WebFetch'];
		const merged = mergeAllowedTools(existing, PLAN_TRACKING_TOOLS);
		expect(merged).toEqual(['Bash', 'WebFetch', 'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']);
	});

	it('deduplicates overlapping entries, keeping first occurrence order', () => {
		const merged = mergeAllowedTools(['TodoWrite', 'Bash'], PLAN_TRACKING_TOOLS);
		expect(merged).toEqual(['TodoWrite', 'Bash', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']);
	});

	it('skips undefined lists', () => {
		expect(mergeAllowedTools(undefined, ['Read'], undefined)).toEqual(['Read']);
	});

	it('returns an empty array when called with nothing', () => {
		expect(mergeAllowedTools()).toEqual([]);
	});
});
