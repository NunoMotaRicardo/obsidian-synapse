import {describe, it, expect} from 'vitest';
import {computeRunCostDelta} from '../src/agentService';
import {isCliVersionAtLeast} from '../src/runtimeManager';

// ---------------------------------------------------------------------------
// computeRunCostDelta / isCliVersionAtLeast (issue #264 AC-3/AC-4)
//
// CLI >= 2.1.277 reports a resumed/forked session's `total_cost_usd` as the whole
// conversation's cumulative cost rather than the current run's own cost. Since
// `Session.send()` spawns a fresh CLI process per call (seeded with `resume`),
// `assistant.run_result.totalCostUsd` must stay a per-run figure on both old
// (per-run) and new (cumulative) CLIs — see `Session`'s `'result'` case and
// specs/agent-service.md "Run cost reporting".
//
// Round 2 review: an earlier version of this logic used a "total >= previous
// total" heuristic instead of a real CLI version check, which misread an old
// CLI's next run as cumulative whenever it happened to cost more than or equal
// to the previous run (run 1 = $0.10, run 2 = $0.15 -> reported $0.05 instead of
// $0.15). computeRunCostDelta() now gates on the resolved CLI version and only
// falls back to that heuristic when the version is unknown/unparseable.
// ---------------------------------------------------------------------------

describe('isCliVersionAtLeast', () => {
	it('returns false for a version below the threshold', () => {
		expect(isCliVersionAtLeast('2.1.276', '2.1.277')).toBe(false);
	});

	it('returns true for a version at the threshold', () => {
		expect(isCliVersionAtLeast('2.1.277', '2.1.277')).toBe(true);
	});

	it('returns true for a version above the threshold', () => {
		expect(isCliVersionAtLeast('2.1.281', '2.1.277')).toBe(true);
		expect(isCliVersionAtLeast('2.2.0', '2.1.277')).toBe(true);
	});

	it('returns undefined for an unknown version', () => {
		expect(isCliVersionAtLeast('unknown', '2.1.277')).toBeUndefined();
	});

	it('returns undefined for an unset version', () => {
		expect(isCliVersionAtLeast(undefined, '2.1.277')).toBeUndefined();
	});

	it('returns undefined for an unparseable version', () => {
		expect(isCliVersionAtLeast('not-a-version', '2.1.277')).toBeUndefined();
	});
});

describe('computeRunCostDelta', () => {
	it('returns the raw value for the first run of a session regardless of CLI version', () => {
		expect(computeRunCostDelta(0.05, undefined, '2.1.281')).toBe(0.05);
		expect(computeRunCostDelta(0.05, undefined, '2.1.200')).toBe(0.05);
		expect(computeRunCostDelta(0.05, undefined, undefined)).toBe(0.05);
	});

	it('passes total_cost_usd through unchanged on a CLI older than 2.1.277 (per-run value)', () => {
		// The exact regression the round 2 review flagged: an old CLI's next run costs
		// more than the previous one — must report the full run cost, not a diff.
		expect(computeRunCostDelta(0.15, 0.10, '2.1.276')).toBe(0.15);
	});

	it('computes the delta on a CLI >= 2.1.277 (cumulative total)', () => {
		expect(computeRunCostDelta(0.15, 0.10, '2.1.277')).toBeCloseTo(0.05);
		expect(computeRunCostDelta(0.22, 0.15, '2.1.281')).toBeCloseTo(0.07);
	});

	it('clamps the delta to 0 on a CLI >= 2.1.277 if the total ever reads below the baseline', () => {
		expect(computeRunCostDelta(0.05, 0.10, '2.1.277')).toBe(0);
	});

	it('falls back to the total >= previous heuristic when the CLI version is unknown', () => {
		expect(computeRunCostDelta(0.15, 0.10, 'unknown')).toBeCloseTo(0.05);
		expect(computeRunCostDelta(0.15, 0.10, undefined)).toBeCloseTo(0.05);
		// Old-CLI-shaped per-run value (below the previous total) still passes through as-is.
		expect(computeRunCostDelta(0.02, 0.10, undefined)).toBe(0.02);
	});
});
