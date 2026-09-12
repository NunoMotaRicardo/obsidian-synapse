/**
 * Electron compatibility shims for the Agent SDK (issues #103/#116; extracted from
 * `agentService.ts` — audit §1, issue #236).
 *
 * This module is part of the single SDK service surface documented in
 * `specs/agent-service.md`: it is statically imported by `agentService.ts` (and
 * `session.ts`) so the top-level `setMaxListeners` shim below still installs at module
 * load — the same load-order behavior as when these blocks lived at the top of
 * `agentService.ts`.
 */

// Compatibility shim for Electron desktop environment.
// Electron's global AbortSignal does not inherit from Node's internal EventTarget/EventEmitter,
// causing events.setMaxListeners(n, signal) inside the Agent SDK to throw ERR_INVALID_ARG_TYPE.
try {
	const nodeReq = typeof window.require === 'function' ? window.require : undefined;
	const events = nodeReq?.('node:events') as typeof import('node:events') | undefined;
	if (events && typeof events.setMaxListeners === 'function') {
		// Intentionally extracted so the wrapper below can call it via `.apply(this,
		// ...)`, which re-binds `this` to whatever `events.setMaxListeners(...)` is
		// called on — the rule can't verify that manual rebinding.
		// eslint-disable-next-line @typescript-eslint/unbound-method -- see comment above
		const origSetMaxListeners = events.setMaxListeners;
		events.setMaxListeners = function(n: number, ...eventTargets: unknown[]) {
			try {
				return origSetMaxListeners.apply(this, [n, ...(eventTargets as unknown as [never])]);
			} catch (e: unknown) {
				if (e && typeof e === 'object' && 'code' in e && (e as {code?: string}).code === 'ERR_INVALID_ARG_TYPE') {
					return;
				}
				throw e;
			}
		};
	}
} catch {
	// ignore polyfill errors
}

// Scoped, refcounted compatibility shim for Electron desktop environment (issue #103/#116).
//
// Electron's renderer keeps the browser/Chromium `setTimeout`, whose return value is a plain
// number — not a Node `Timeout` with `.unref()`. The Agent SDK's `ProcessTransport.close()`
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs) calls `.unref()` unconditionally on a
// SIGTERM→SIGKILL escalation timer whenever `close()` runs while the CLI subprocess is still
// alive, throwing `TypeError: setTimeout(...).unref is not a function`.
//
// Investigation for #116 established that this branch is NOT reached by ordinary query
// completion: `ProcessTransport.readMessages()` always `await`s `waitForExit()` before its
// generator finishes, so by the time the SDK's own cleanup path calls `transport.close()`
// the process has already exited and the escalation branch is skipped — confirmed empirically
// (several partial-message chat sends produced zero console errors without any shim at all).
//
// The branch IS reached when a query is aborted mid-stream: `AbortController.abort()`
// synchronously fires an internal `abort` listener that calls `transport.close()` directly,
// outside the SDK's own try/catch, while the process is typically still running — hitting the
// crash once immediately (the outer escalation timer) and, on win32, potentially again ~2s
// later (the nested SIGKILL timer scheduled by that same escalation callback). See
// `Session.abort()`, which installs this shim only around that forced-kill window.
//
// Refcounted so overlapping aborts (e.g. two sessions racing to stop) don't restore the
// original `setTimeout` while another abort is still relying on the shim.
let setTimeoutShimRefCount = 0;
let originalSetTimeout: typeof globalThis.setTimeout | null = null;

export function installSetTimeoutShim(): void {
	setTimeoutShimRefCount++;
	if (setTimeoutShimRefCount > 1) return;
	try {
		originalSetTimeout = globalThis.setTimeout;
		if (typeof originalSetTimeout !== 'function') return;
		const original = originalSetTimeout;
		globalThis.setTimeout = ((...args: Parameters<typeof original>) => {
			const id: unknown = original(...args);
			if (id === null || (typeof id !== 'number' && typeof id !== 'bigint')) return id;
			// `Object(id)` still coerces to the same numeric id via `valueOf()` for
			// `clearTimeout()` (per the WebIDL `long` conversion both use), so no existing
			// `setTimeout`/`clearTimeout` caller elsewhere in the plugin (or Obsidian
			// itself) is affected while the shim is installed.
			const handle = Object(id) as {unref?: () => unknown; ref?: () => unknown};
			handle.unref = () => handle;
			handle.ref = () => handle;
			return handle;
		}) as typeof original;
	} catch {
		// ignore polyfill errors
	}
}

export function uninstallSetTimeoutShim(): void {
	setTimeoutShimRefCount = Math.max(0, setTimeoutShimRefCount - 1);
	if (setTimeoutShimRefCount === 0 && originalSetTimeout) {
		globalThis.setTimeout = originalSetTimeout;
		originalSetTimeout = null;
	}
}

/**
 * Force-restore `globalThis.setTimeout` immediately, regardless of outstanding refcount.
 * Called from `AgentService.stop()` (plugin unload path) so an in-flight abort's shim never
 * outlives the plugin — see the register/unload conventions in CLAUDE.md.
 */
export function forceRestoreSetTimeoutShim(): void {
	setTimeoutShimRefCount = 0;
	if (originalSetTimeout) {
		globalThis.setTimeout = originalSetTimeout;
		originalSetTimeout = null;
	}
}

/**
 * Milliseconds the shim must stay installed after an abort to outlive the SDK's own
 * escalation timers: a 2s outer check, plus (on win32, if the process still hasn't exited)
 * a further 5s SIGKILL timer scheduled from inside that same callback. A little headroom is
 * added on top of the 7s worst case.
 */
export const ABORT_SHIM_GRACE_MS = 8000;