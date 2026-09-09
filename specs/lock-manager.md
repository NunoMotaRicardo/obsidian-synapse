# lock-manager

## Overview

An in-memory, per-file **advisory** write lock that serializes plugin-initiated writes to the same
vault-relative path, so concurrent batch loops and self-improve/config writes do not
interleave `vault.read()`/`vault.modify()` and clobber one another.

Advisory and in-process: the lock only guards writes that go **through the plugin's own code
paths** (`configWriter.ts`, `runExecutor.ts`'s report appends on behalf of `batchLoopExecutor.ts`).
It does
**not** — and cannot — guard writes the Claude CLI performs directly via its own file tools during
an `inlineChat()` run, nor a user's manual edits in the Obsidian editor. Those are outside the
plugin's write surface. The lock's job is narrow: stop the plugin from racing *itself* when two of
its own async write flows target the same note.

Source: `src/lockManager.ts`.

## Interface

A single module-level singleton (`lockManager`), mirroring how other shared helpers are
exported — this avoids threading a `LockManager` instance through every free function
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
  `vault.modify`/`vault.trash` in `withLock(targetPath, …)`: `writeAgent`,
  `writeSkill`, `modifyArtifact`, `deleteArtifact`. Read-only scans (`scanAgents`, etc.) and
  `ensureFolder` are not locked.
- **`runExecutor.ts`** — `appendReportBlock(app, target, block)` wraps its read-modify-write in
  `withLock(target.path, …)`, so two batch-loop runs writing the same day's report do
  not interleave (triggers were removed in issue #188; this pipeline now only serves batch loops
  and single-file inline-chat write-backs). `batchLoopExecutor.ts`'s `appendToReport`/`appendRunSummary` call through this
  shared helper rather than locking directly; a timeout here is not specially caught, it propagates
  like any other write failure into the per-file loop body's existing error handling (counted as a
  failed file, logged, with a best-effort error-report append of its own). `runExecutor.ts` also
  wraps the `write: true` write-back mode's file modify in `withLock`, catching
  `LockAcquisitionError` specifically to fall back to a report append instead of failing the run.

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
(`writeAgent`, `writeSkill`, `modifyArtifact`, `deleteArtifact`) and `runExecutor.ts`
(`appendReportBlock`, and the `write: true` write-back path). Unit tests in
`test/lockManager.test.ts` cover FIFO serialization,
independent-path concurrency, release-on-throw, and the timeout/`LockAcquisitionError` path.
Foundation for the multi-writer safety of batch loops (`batch-loops.md`) and future Tier-1
autonomous loops (#67).
