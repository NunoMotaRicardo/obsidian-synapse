/**
 * Lock manager — an in-memory, per-file **advisory** write lock that
 * serializes plugin-initiated writes to the same vault-relative note, so
 * concurrent self-improve/config writes and report appends don't
 * interleave `vault.read()`/`vault.modify()` and clobber each other.
 *
 * Advisory and in-process only: this guards writes that go through the
 * plugin's own code paths (`configWriter.ts`, and `runExecutor.ts`'s report
 * appends). It cannot
 * — and does not try to —
 * guard writes the Claude CLI makes via its own file tools during an
 * `inlineChat()` run, nor a user's manual edits in the Obsidian editor. See
 * `specs/lock-manager.md` for the full scope note.
 */

import {normalizePath} from 'obsidian';

/** Thrown by `withLock` when a queued acquisition exceeds `LOCK_TIMEOUT_MS`. */
export class LockAcquisitionError extends Error {
	constructor(path: string) {
		super(`[synapse] Timed out waiting for lock on "${path}"`);
		this.name = 'LockAcquisitionError';
	}
}

/**
 * Bounded wait for a queued acquisition. Generous enough to cover a slow
 * `inlineChat()`-backed write (report appends, artifact writes) without
 * making a genuinely wedged holder block the queue indefinitely. 60s
 * comfortably exceeds ordinary vault.modify() latency; a holder still
 * running past that is treated as wedged.
 */
export const LOCK_TIMEOUT_MS = 60_000;

/**
 * Per-path tail-chain of queued work. Each entry in the map is a promise
 * that resolves once the current holder (and everything queued ahead of a
 * new caller) has released the lock — the race-free FIFO primitive
 * described in `specs/lock-manager.md`.
 */
class LockManager {
	private readonly tails = new Map<string, Promise<void>>();

	/**
	 * Serialize `fn` against other writers of the same normalized path.
	 * Queues FIFO behind the current holder (if any) and runs `fn` once
	 * acquired. Always releases in `finally`, whether `fn` resolves, throws,
	 * or the acquisition itself times out.
	 */
	async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
		const key = normalizePath(path);
		const previousTail = this.tails.get(key) ?? Promise.resolve();

		// releaseLock is invoked exactly once, by this call's `finally`, whether
		// we ran `fn`, `fn` threw, or acquisition itself timed out — it's what
		// the *next* queued waiter's `waitTurn` awaits, so it must always fire
		// or a timed-out caller would permanently wedge everyone queued behind it.
		let releaseLock: () => void = () => {};
		const ownTail = new Promise<void>(resolve => {
			releaseLock = resolve;
		});
		// Publish our tail immediately so a caller that queues behind us (before
		// we've finished waiting for `previousTail`) chains onto us, not onto
		// whichever holder we're currently waiting behind.
		this.tails.set(key, ownTail);

		let acquired = false;

		try {
			// Wait for our turn, bounded by LOCK_TIMEOUT_MS so a wedged holder
			// ahead of us can't block this acquisition forever.
			await this.waitTurn(previousTail, key);
			acquired = true;
			return await fn();
		} finally {
			if (acquired) {
				releaseLock();
				// Only clear the map entry if nobody has queued behind us — if a
				// later caller already replaced `tails.get(key)` with their own
				// tail, leave the map alone (their tail is now the current one).
				if (this.tails.get(key) === ownTail) {
					this.tails.delete(key);
				}
			} else {
				// If we timed out waiting, don't unblock callers queued behind us until the
				// previous tail resolves (otherwise they can run concurrently with the holder).
				void previousTail.finally(() => {
					releaseLock();
					if (this.tails.get(key) === ownTail) {
						this.tails.delete(key);
					}
				});
			}
		}
	}

	/** Wait for `previousTail` to settle, or reject with `LockAcquisitionError` after the timeout. */
	private async waitTurn(previousTail: Promise<void>, key: string): Promise<void> {
		let timeoutHandle: number;
		const timeout = new Promise<never>((_, reject) => {
			timeoutHandle = window.setTimeout(() => reject(new LockAcquisitionError(key)), LOCK_TIMEOUT_MS);
		});
		try {
			await Promise.race([previousTail, timeout]);
		} finally {
			window.clearTimeout(timeoutHandle!);
		}
	}
}

/** Module-level singleton, imported directly. */
export const lockManager = new LockManager();
