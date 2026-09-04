import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {SynapseSettingTab} from '../src/settings';
import type SynapsePlugin from '../src/main';

// ---------------------------------------------------------------------------
// Provider field debounce (issue #148)
//
// The provider Base URL / API key text fields' onChange handlers used to call
// `plugin.initAgentService()` (tears down and rebuilds `AgentService`, fires
// `fetchProviderModels()`) on every keystroke. They now go through a single
// `debounce(fn, 500, true)` instance field on `SynapseSettingTab`. These tests
// reach into that private field the same way `test/mcpBridge.test.ts` reaches
// into `McpBridgeSession._drainLines` — there is no public surface to observe
// "how many times would initAgentService fire" other than driving the real
// debouncer used by the settings tab.
//
// `test/setup.ts` mocks `obsidian`'s `debounce()` as a faithful reimplementation
// of its documented contract (the real one lives in Obsidian's closed-source
// app.js), so this exercises real trailing-edge-debounce semantics, not a stub
// that always resolves to "called once".
// ---------------------------------------------------------------------------

type DebouncedHandle = {(): void; cancel: () => void};

function getDebouncedInitAgentService(tab: SynapseSettingTab): DebouncedHandle {
	return (tab as unknown as {debouncedInitAgentService: DebouncedHandle}).debouncedInitAgentService;
}

function makeTab(initAgentService: () => Promise<void>): SynapseSettingTab {
	const fakeApp = {} as unknown as ConstructorParameters<typeof SynapseSettingTab>[0];
	const fakePlugin = {initAgentService} as unknown as SynapsePlugin;
	return new SynapseSettingTab(fakeApp, fakePlugin);
}

describe('SynapseSettingTab provider field debounce (#148)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('collapses a 22-keystroke burst (e.g. typing "http://localhost:11434") into exactly one initAgentService() call', () => {
		const initAgentService = vi.fn().mockResolvedValue(undefined);
		const tab = makeTab(initAgentService);
		const debounced = getDebouncedInitAgentService(tab);

		const url = 'http://localhost:11434';
		expect(url.length).toBe(22);

		// Simulate 22 keystrokes 50ms apart — well under the 500ms window, so the
		// timer keeps resetting and never fires mid-burst.
		for (let i = 0; i < url.length; i++) {
			debounced();
			vi.advanceTimersByTime(50);
		}
		expect(initAgentService).not.toHaveBeenCalled();

		// Quiet period: the last keystroke's timer fires 500ms after it, not before.
		vi.advanceTimersByTime(449);
		expect(initAgentService).not.toHaveBeenCalled();
		vi.advanceTimersByTime(51);
		expect(initAgentService).toHaveBeenCalledTimes(1);
	});

	it('still fires once for a single keystroke (first-and-only-keystroke case)', () => {
		const initAgentService = vi.fn().mockResolvedValue(undefined);
		const tab = makeTab(initAgentService);
		const debounced = getDebouncedInitAgentService(tab);

		debounced();
		vi.advanceTimersByTime(500);
		expect(initAgentService).toHaveBeenCalledTimes(1);
	});

	it('hide() cancels a pending call so it cannot fire after the settings tab closes', () => {
		const initAgentService = vi.fn().mockResolvedValue(undefined);
		const tab = makeTab(initAgentService);
		const debounced = getDebouncedInitAgentService(tab);

		debounced();
		tab.hide();
		vi.advanceTimersByTime(10_000);
		expect(initAgentService).not.toHaveBeenCalled();
	});
});
