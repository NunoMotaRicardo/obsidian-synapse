/* eslint-disable @typescript-eslint/unbound-method -- these tests deliberately retain and compare the renderer's timer method identity. */
import {afterEach, describe, expect, it, vi} from 'vitest';

const SET_TIMEOUT_SHIM_STATE = Symbol.for('synapse.setTimeoutShimState');
const rendererWindow = window as typeof window & Record<symbol, unknown>;
let originalSetTimeout: typeof window.setTimeout | undefined;

afterEach(() => {
	if (originalSetTimeout) window.setTimeout = originalSetTimeout;
	originalSetTimeout = undefined;
	delete rendererWindow[SET_TIMEOUT_SHIM_STATE];
	vi.resetModules();
});

describe('SDK setTimeout compatibility shim', () => {
	it('wraps numeric renderer timer handles and restores the timer after every reference releases', async () => {
		originalSetTimeout = window.setTimeout;
		const numericSetTimeout = vi.fn(() => 42) as unknown as typeof window.setTimeout;
		window.setTimeout = numericSetTimeout;

		const shims = await import('../src/sdkShims');
		const handle = window.setTimeout(() => undefined, 10) as unknown as {
			unref: () => unknown;
			ref: () => unknown;
			valueOf: () => number;
		};

		expect(handle.valueOf()).toBe(42);
		expect(handle.unref()).toBe(handle);
		expect(handle.ref()).toBe(handle);

		shims.installSetTimeoutShim();
		shims.uninstallSetTimeoutShim();
		expect(window.setTimeout).not.toBe(numericSetTimeout);
		shims.uninstallSetTimeoutShim();
		expect(window.setTimeout).toBe(numericSetTimeout);
	});

	it('shares a lifecycle reference across module reloads', async () => {
		originalSetTimeout = window.setTimeout;
		const numericSetTimeout = vi.fn(() => 1) as unknown as typeof window.setTimeout;
		window.setTimeout = numericSetTimeout;

		const firstLoad = await import('../src/sdkShims');
		vi.resetModules();
		const secondLoad = await import('../src/sdkShims');

		secondLoad.uninstallSetTimeoutShim();
		expect(window.setTimeout).not.toBe(numericSetTimeout);
		firstLoad.uninstallSetTimeoutShim();
		expect(window.setTimeout).toBe(numericSetTimeout);
	});
});
/* eslint-enable @typescript-eslint/unbound-method -- renderer timer identity checks end here. */
