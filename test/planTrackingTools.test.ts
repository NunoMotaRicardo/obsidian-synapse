import {describe, it, expect} from 'vitest';
import {PLAN_TRACKING_TOOLS} from '../src/agentService';

// ---------------------------------------------------------------------------
// PLAN_TRACKING_TOOLS (issue #264 AC-1/AC-2)
//
// CLI 2.1.268 made TodoWrite/TaskCreate/TaskGet/TaskUpdate/TaskList default tools only on
// a specific model list; elsewhere (Opus 5.x, Sonnet 5) they must be explicitly listed in
// `allowedTools` or the plan panel never receives a tool call to parse. `buildSessionConfig()`
// sets `allowedTools: [...PLAN_TRACKING_TOOLS]` — `allowedTools` only auto-allows/enables
// tools, it doesn't replace the base toolset the way `tools` would (verified against CLI
// 2.1.281 — see specs/agent-service.md "Plan/task tracking").
// ---------------------------------------------------------------------------

describe('PLAN_TRACKING_TOOLS', () => {
	it('lists both the legacy TodoWrite tool and the TaskCreate/Get/Update/List family', () => {
		expect(PLAN_TRACKING_TOOLS).toEqual(['TodoWrite', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']);
	});
});
