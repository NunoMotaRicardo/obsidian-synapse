# lock-manager

## Overview

An in-memory, per-file **advisory** write lock that serializes plugin-initiated writes to the same
vault-relative path, so concurrent config writes do not
interleave `vault.read()`/`vault.modify()` and clobber one another.

Advisory and in-process: the lock only guards writes that go **through the plugin's own code
paths** (`configWriter.ts`'s locked writers — `writeSkill`, `installStarterKit`, `persistToolApprovalRules`). It does
**not** — and cannot — guard writes the Claude CLI performs directly via its own file tools during
an `inlineChat()` run, nor a user's manual edits in the Obsidian editor. Those are outside the
plugin's write surface. The lock's job is narrow: stop the plugin from racing *itself* when two of
its own async write flows target the same note.

Source: `src/lockManager.ts`.

## Interface

A single module-level singleton (`lockManager`), mirroring how other shared helpers are
exported — this avoids threading a `LockManager` instance through every free function
in `configWriter.ts` for starter-kit installation, skill creation, and approval persistence.

```ts
// Serialize `fn` against other writers of the same normalized path. If the path
// is already held, this call queues behind the current holder (FIFO per path)
// and runs when the lock frees. A bounded acquisition timeout fails gracefully
// (throws LockAcquisitionError) rather than hanging forever if a holder wedges.
withLock<T>(path: string, fn: () => Promise<T>): Promise<T>
```

- **Granularity:** one lock per `normalizePath(path)` — the manager normalizes internally, so
  callers can pass either a raw or already-normalized path and `foo/Bar.md`/`foo\Bar.md` map to
  the same lock.
- **Acquisition:** same-path writers queue (a per-path promise chain, `Map<string, Promise<void>>`
  tail) rather than being dropped — no write is silently lost when contention is merely temporal.
  A bounded wait (`LOCK_TIMEOUT_MS`, 60s) guards against a wedged holder; on timeout the queued
  acquisition rejects with `LockAcquisitionError` so the caller can degrade gracefully instead of
  blocking indefinitely. 60s was chosen to comfortably exceed ordinary `vault.modify()` latency and
  file creation, while still bounding the worst case.
- **Release:** always in a `finally` inside `withLock` — the lock frees whether `fn` resolves,
  or throws. A timed-out waiter skips `fn` and defers releasing its tail until the previous
  holder finishes; this prevents later writers from overtaking a still-running holder. An empty
  queue (nobody queued behind the releasing call) deletes the map entry so the map does not grow
  unbounded.

## Integration points

- **`configWriter.ts`** — every function that mutates a vault file wraps its `vault.create`/
  `vault.modify` in `withLock(targetPath, …)`: `writeSkill`, `installStarterKit`,
  `persistToolApprovalRules`. Starter-file existence checks and folder creation occur outside
  the file lock; the lock does not make repeated concurrent initialization idempotent.
  Read-only scans (`scanAgents`, etc.) and `ensureFolder` are not locked.

## Invariants

- The lock is advisory and in-process only — never presented as a guarantee against CLI-side or
  manual-editor writes (see Overview). Document this wherever it is surfaced to users.
- Locks are keyed by normalized vault-relative path. Successful/failed holders release in
  `finally`; timed-out waiters release only after the preceding tail settles.
- Contention on the same path serializes by default. Acquisition timeout rejects to the caller;
  the manager does not log, show Notices, or cancel a running holder.
- No persistence — the map is rebuilt empty on plugin load; a plugin reload cannot leave a stale
  lock held.

`src/lockManager.ts` exports the `lockManager` singleton (`withLock`) and
`LockAcquisitionError` and `LOCK_TIMEOUT_MS`; integrated into `configWriter.ts` (`writeSkill`,
`installStarterKit`, `persistToolApprovalRules`). Unit tests in `test/lockManager.test.ts` cover FIFO
serialization, independent-path concurrency, release-on-throw, and the
timeout/`LockAcquisitionError` path.

