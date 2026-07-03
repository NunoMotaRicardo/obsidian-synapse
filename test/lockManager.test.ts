import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {lockManager, LockAcquisitionError, LOCK_TIMEOUT_MS} from '../src/lockManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve after `ms` (real timers unless a test opts into fake timers). */
function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Serialization of concurrent same-path writers
// ---------------------------------------------------------------------------

describe('lockManager.withLock — serialization', () => {
	it('serializes two concurrent writers on the same path (FIFO, no interleave)', async () => {
		const events: string[] = [];

		const first = lockManager.withLock('note.md', async () => {
			events.push('first-start');
			await delay(20);
			events.push('first-end');
			return 'first';
		});

		// Queue the second call while the first is still holding the lock.
		const second = lockManager.withLock('note.md', async () => {
			events.push('second-start');
			await delay(5);
			events.push('second-end');
			return 'second';
		});

		const results = await Promise.all([first, second]);

		expect(results).toEqual(['first', 'second']);
		// The second call's body must not start until the first has fully
		// finished — no interleaving of the two critical sections.
		expect(events).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
	});

	it('queues three writers in FIFO order', async () => {
		const order: number[] = [];

		const run = (n: number) => lockManager.withLock('queue.md', async () => {
			order.push(n);
			await delay(5);
		});

		await Promise.all([run(1), run(2), run(3)]);

		expect(order).toEqual([1, 2, 3]);
	});

	it('independent paths run in parallel, not serialized against each other', async () => {
		const events: string[] = [];

		const a = lockManager.withLock('a.md', async () => {
			events.push('a-start');
			await delay(20);
			events.push('a-end');
		});
		const b = lockManager.withLock('b.md', async () => {
			events.push('b-start');
			await delay(5);
			events.push('b-end');
		});

		await Promise.all([a, b]);

		// b (shorter delay, independent path) finishes before a, proving they
		// ran concurrently rather than being serialized behind one another.
		expect(events.indexOf('b-end')).toBeLessThan(events.indexOf('a-end'));
		expect(events).toContain('a-start');
		expect(events).toContain('b-start');
	});

	it('normalizes path separators so equivalent paths serialize together', async () => {
		const events: string[] = [];

		const first = lockManager.withLock('folder/note.md', async () => {
			events.push('first-start');
			await delay(15);
			events.push('first-end');
		});
		const second = lockManager.withLock('folder\\note.md', async () => {
			events.push('second-start');
		});

		await Promise.all([first, second]);

		expect(events).toEqual(['first-start', 'first-end', 'second-start']);
	});
});

// ---------------------------------------------------------------------------
// isLocked
// ---------------------------------------------------------------------------

describe('lockManager.isLocked', () => {
	it('is false before acquisition and after release', async () => {
		expect(lockManager.isLocked('probe.md')).toBe(false);

		const held = lockManager.withLock('probe.md', async () => {
			await delay(10);
		});

		expect(lockManager.isLocked('probe.md')).toBe(true);

		await held;

		expect(lockManager.isLocked('probe.md')).toBe(false);
	});

	it('deletes the map entry once the queue empties (no unbounded growth)', async () => {
		await lockManager.withLock('gc.md', async () => {
			/* no-op */
		});
		expect(lockManager.isLocked('gc.md')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Release-on-throw
// ---------------------------------------------------------------------------

describe('lockManager.withLock — release on throw', () => {
	it('releases the lock even when fn throws, and rejects with the original error', async () => {
		const err = new Error('boom');

		await expect(
			lockManager.withLock('error.md', async () => {
				throw err;
			}),
		).rejects.toBe(err);

		expect(lockManager.isLocked('error.md')).toBe(false);
	});

	it('a subsequent writer still acquires the lock after a prior holder threw', async () => {
		const order: string[] = [];

		await expect(
			lockManager.withLock('error-chain.md', async () => {
				order.push('threw');
				throw new Error('fail');
			}),
		).rejects.toThrow('fail');

		const result = await lockManager.withLock('error-chain.md', async () => {
			order.push('succeeded');
			return 'ok';
		});

		expect(result).toBe('ok');
		expect(order).toEqual(['threw', 'succeeded']);
	});

	it('queued writers still run in order when an earlier holder throws', async () => {
		const order: string[] = [];

		const first = lockManager.withLock('error-queue.md', async () => {
			order.push('first');
			await delay(10);
			throw new Error('first failed');
		}).catch(() => { /* expected */ });

		const second = lockManager.withLock('error-queue.md', async () => {
			order.push('second');
		});

		await Promise.all([first, second]);

		expect(order).toEqual(['first', 'second']);
	});
});

// ---------------------------------------------------------------------------
// Timeout / LockAcquisitionError
// ---------------------------------------------------------------------------

describe('lockManager.withLock — acquisition timeout', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('rejects a queued waiter with LockAcquisitionError if the holder wedges past the timeout', async () => {
		let releaseHolder: () => void = () => {};
		const holderGate = new Promise<void>(resolve => {
			releaseHolder = resolve;
		});

		// Holder never resolves until we release it below — simulates a wedge.
		const holder = lockManager.withLock('wedge.md', async () => {
			await holderGate;
			return 'held';
		});

		const waiterPromise = lockManager.withLock('wedge.md', async () => 'should-not-run');

		// Attach a rejection handler immediately so vitest doesn't flag an
		// "unhandled rejection" while fake timers advance below.
		const waiterExpectation = expect(waiterPromise).rejects.toBeInstanceOf(LockAcquisitionError);

		await vi.advanceTimersByTimeAsync(LOCK_TIMEOUT_MS + 1);

		await waiterExpectation;

		// Release the wedged holder so it doesn't leak into other tests/paths.
		releaseHolder();
		await holder;
	});

	it('a waiter queued behind a timed-out acquisition is not itself permanently wedged', async () => {
		let releaseHolder: () => void = () => {};
		const holderGate = new Promise<void>(resolve => {
			releaseHolder = resolve;
		});

		const holder = lockManager.withLock('wedge-chain.md', async () => {
			await holderGate;
		});

		// This waiter will time out waiting behind `holder`.
		const timedOutWaiter = lockManager.withLock('wedge-chain.md', async () => 'never');
		const timedOutExpectation = expect(timedOutWaiter).rejects.toBeInstanceOf(LockAcquisitionError);

		await vi.advanceTimersByTimeAsync(LOCK_TIMEOUT_MS + 1);
		await timedOutExpectation;

		// Now release the original holder — a fresh acquisition afterward must
		// still succeed (the timed-out waiter's release must have fired so it
		// didn't leave the queue permanently stuck).
		releaseHolder();
		await holder;

		const result = await lockManager.withLock('wedge-chain.md', async () => 'ok-after-timeout');
		expect(result).toBe('ok-after-timeout');
	});
});
