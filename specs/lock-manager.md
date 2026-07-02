# lock-manager

## Overview

An in-memory, per-file **advisory** write lock that serializes plugin-initiated writes to the same
vault-relative path, so concurrent triggers, batch loops, and self-improve/config writes do not
interleave `vault.read()`/`vault.modify()` and clobber one another.

Advisory and in-process: the lock only guards writes that go **through the plugin's own code
paths** (`configWriter.ts`, `triggerExecutor.ts`, `batchLoopExecutor.ts` report appends). It does
**not** — and cannot — guard writes the Claude CLI performs directly via its own file tools during
an `inlineChat()` run, nor a user's manual edits in the Obsidian editor. Those are outside the
plugin's write surface. The lock's job is narrow: stop the plugin from racing *itself* when two of
its own async write flows target the same note.

Source: `src/lockManager.ts`.

## Interface

A single module-level singleton (`lockManager`), mirroring how `vaultTools` and other shared
helpers are exported — this avoids threading a `LockManager` instance through every free function
in `configWriter.ts` and their many callers (self-improve tool handlers, seeding, etc.).

```ts
// Serialize `fn` against other writers of the same normalized path. If the path
// is already held, this call queues behind the current holder (FIFO per path)
// and runs when the lock frees. A bounded acquisition timeout fails gracefully
// (throws LockAcquisitionError) rather than hanging forever if a holder wedges.
withLock<T>(path: string, fn: () => Promise<T>): Promise<T>

// Non-throwing probe — true if the path currently has a holder or a queue.
isLocked(path: string): boolean
```

- **Granularity:** one lock per `normalizePath(path)` — the manager normalizes internally, so
  callers can pass either a raw or already-normalized path and `foo/Bar.md`/`foo\Bar.md` map to
  the same lock.
- **Acquisition:** same-path writers queue (a per-path promise chain, `Map<string, Promise<void>>`
  tail) rather than being dropped — no write is silently lost when contention is merely temporal.
  A bounded wait (`LOCK_TIMEOUT_MS`, 60s) guards against a wedged holder; on timeout the queued
  acquisition rejects with `LockAcquisitionError` so the caller can degrade gracefully instead of
  blocking indefinitely. 60s was chosen to comfortably exceed ordinary `vault.modify()` latency and
  a slow `inlineChat()`-backed write-back, while still bounding the worst case.
- **Release:** always in a `finally` inside `withLock` — the lock frees whether `fn` resolves,
  throws, *or* the wait for a turn itself times out (a timed-out waiter still publishes and later
  releases its own tail, so a caller queued behind a timeout is not permanently wedged). An empty
  queue (nobody queued behind the releasing call) deletes the map entry so the map does not grow
  unbounded.

## Integration points

- **`configWriter.ts`** — every function that mutates a vault file wraps its `vault.create`/
  `vault.modify`/`vault.trash` in `withLock(targetPath, …)`: `writeAgent`, `writeTrigger`,
  `writeSkill`, `modifyArtifact`, `deleteArtifact`. Read-only scans (`scanAgents`, etc.) and
  `ensureFolder` are not locked.
- **`triggerExecutor.ts`** — `applyWriteMode` (both `write: true` full-file replace and
  `write: 'frontmatter'` merge, the latter via `modifyArtifact`'s own lock) and `appendToReport`
  acquire the lock on their target path. On a `LockAcquisitionError`, the executor degrades
  gracefully: `console.warn` (with the `[synapse]` prefix) and, where a report exists to fall back
  to, appends a note there instead — rather than throwing out of `executeTrigger`. `appendToReport`
  itself is the last line of defense; if *its* lock acquisition times out, the entry is dropped
  with a `console.warn` (there is nowhere further to degrade to).
- **`batchLoopExecutor.ts`** — report appends (`appendBlockToReport`, used by both `appendToReport`
  and `appendRunSummary`) acquire the lock on the report path, so a batch-loop run and a trigger
  writing the same day's report do not interleave. A timeout here is not specially caught; it
  propagates like any other write failure into `runBatchLoop()`'s existing per-file error handling
  (counted as a failed file, logged, with a best-effort error-report append of its own).

## Invariants

- The lock is advisory and in-process only — never presented as a guarantee against CLI-side or
  manual-editor writes (see Overview). Document this wherever it is surfaced to users.
- Locks are keyed by normalized vault-relative path; a lock is released in a `finally` block on
  every path (success, error, or timeout).
- Contention on the same path serializes (queues) by default; only a wedged holder (timeout) turns
  into a graceful failure — and that failure is logged + reported, never swallowed silently.
- No persistence — the map is rebuilt empty on plugin load; a plugin reload cannot leave a stale
  lock held.

## Current status

Implemented (issue #68). `src/lockManager.ts` exports the `lockManager` singleton
(`withLock`/`isLocked`) and `LockAcquisitionError`; integrated into `configWriter.ts`
(`writeAgent`, `writeTrigger`, `writeSkill`, `modifyArtifact`, `deleteArtifact`),
`triggerExecutor.ts` (`applyWriteMode`, `appendToReport`), and `batchLoopExecutor.ts`
(`appendBlockToReport`). Unit tests in `test/lockManager.test.ts` cover FIFO serialization,
independent-path concurrency, release-on-throw, and the timeout/`LockAcquisitionError` path.
Foundation for the multi-writer safety of triggers (`bots-triggers.md`), batch loops
(`batch-loops.md`), and future Tier-1 autonomous loops (#67).
