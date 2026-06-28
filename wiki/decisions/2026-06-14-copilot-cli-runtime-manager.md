# Copilot CLI runtime manager: prefer system CLI, plugin-managed download as fallback

## Context

Sidekick is an Obsidian plugin, but it doesn't talk to GitHub Copilot directly. It drives a
system-installed `copilot` CLI binary over JSON-RPC (via `@github/copilot-sdk`). That means
the plugin only works if a compatible `copilot` CLI actually exists on the user's machine —
and right now, finding it is fragile:

- The logic that locates the binary (and sanitizes the environment to launch it) is ad-hoc
  code buried inside the SDK wrapper.
- If no CLI is found, or the one that's found is too old to speak the protocol the SDK
  expects, the user hits a dead end with little explanation. For a non-technical Obsidian
  user who installed Sidekick expecting it to "just work", this is the single biggest
  install-time cliff.

This decision was first sketched in a `grill-me` interview on **2026-06-12** ("Runtime
delivery: prefer system-installed Copilot CLI; fallback = plugin-managed direct npm-registry
tarball download"), and audited and scoped into shippable work on **2026-06-14**. It is
tracked by GitHub issue **#2** (the runtime manager) and its three sub-issues **#13 / #14 /
#15**.

## Decision

1. **Prefer whatever the user already has.** A system-installed Copilot CLI — installed via
   `npm -g`, WinGet, or pointed at explicitly in settings — is always the first choice.
   Sidekick should never override or auto-update a CLI the user manages themselves.

2. **Fall back to a plugin-managed copy when nothing usable is found.** If no compatible CLI
   exists, Sidekick can download a platform-matched runtime itself, straight from the npm
   registry, into a private folder it owns. The user never has to open a terminal.

3. **Tell the user what's going on.** Settings shows which binary Sidekick resolved, and a
   version/protocol mismatch produces a friendly, actionable notice instead of a silent
   failure.

4. **Ship it in three independently useful slices** (#13 → then #14 and #15 in either order),
   rather than one large change.

The *how* — the exact resolution-chain order, the download URL scheme, build-time version
pinning, and the safety invariants — lives in the technical spec and is not duplicated here:
see [`specs/runtime-manager.md`](../../specs/runtime-manager.md).

## Rationale

**Why prefer the system CLI.** Users who already run Copilot in VS Code or the terminal have
a CLI they trust and update on their own schedule. Hijacking that would be surprising and
could fight with their own tooling. Respecting it keeps Sidekick a good citizen on the
machine.

**Why a built-in fallback at all.** The alternative — telling users "go install the Copilot
CLI yourself" — is exactly the friction that makes plugins feel broken. Downloading the
runtime ourselves turns a multi-step, terminal-bound setup into a single button. Pulling from
the npm registry directly (rather than shelling out to `npm`) means it works even on machines
that don't have Node/npm installed at all.

**Why split into #13 / #14 / #15.** The full scope mixes a harmless refactor with genuinely
sensitive work: fetching a remote file, extracting an archive, and writing an executable to
disk. Bundling those together would force the risky part to ride along with the safe part
through a single review, and would mean nothing is demonstrable until everything is done.
Splitting lets each slice be reviewed and shown on its own terms:

- **#13 — Extract the runtime manager + plugin-managed `bin/` resolution (foundation, no
  network).** Moves CLI resolution into its own module and adds a plugin-owned binary folder
  to the search order, so a future download has a home. Pure refactor plus one new lookup
  candidate. Benefit on its own: cleaner, testable resolution and a settings line showing the
  resolved binary path — already an improvement in transparency, with zero new attack
  surface. This is the foundation the other two build on.

- **#14 — Download the CLI tarball from the npm registry (the security-sensitive slice,
  depends on #13).** This is the slice that earns its own dedicated review round: remote
  fetch, gunzip + tar extraction, path-traversal validation, write-to-temp-then-rename so a
  failed download never leaves a corrupt binary, and Download / Update / Remove buttons in
  settings. Isolating it means the security review can focus entirely on this surface without
  being diluted by refactor noise. Benefit: the actual one-click "get me a working runtime"
  experience for users with no CLI.

- **#15 — Post-connect version/protocol check + mismatch notice (independent of #14, pairs
  with #13).** After connecting, Sidekick asks the CLI what version and protocol it speaks,
  logs it, and if it's incompatible shows a notice naming the resolved binary and pointing at
  `copilot update` (or the built-in downloader once #14 lands). Benefit: turns the worst
  failure mode — a too-old CLI that connects but misbehaves — into a clear, named, fixable
  message. It's valuable even before #14 exists, which is why it's deliberately not chained to
  it.

This ordering also means there's always a shippable, demonstrable increment: #13 improves
transparency immediately, #15 improves diagnostics, and #14 delivers the headline feature once
the foundation is proven.

## Scope / Non-goals

- **No auto-updating of a system-managed CLI.** If the user installed Copilot themselves,
  Sidekick reports staleness but never silently replaces it.
- **Desktop only.** No mobile runtime story — Sidekick is a desktop plugin and the CLI is a
  desktop binary.
- **The plugin-managed download targets a single pinned version** (the SDK's bundled
  `@github/copilot` dependency, build-time pinned), not an arbitrary user-chosen version.
- **No GitHub Projects/board choreography** beyond the issue split itself.

## Open Questions

- None blocking. The recommended build order is settled (#13 first; then #14 and #15 in either
  order). Remaining specifics (exact notice copy, settings layout) are implementation detail
  for the planner/coder and the spec.

## Hand-off Notes for the Technical Planner

- The functional intent is captured above and in issues #2 / #13 / #14 / #15; the technical
  design already lives in [`specs/runtime-manager.md`](../../specs/runtime-manager.md) (status:
  planned). Keep that spec the single home for resolution-chain order, URL scheme, version
  pinning, invariants, and non-goals — this record intentionally does not restate them.
- The one functional guarantee worth enforcing across all three slices: **a system-installed
  CLI the user manages must always win, and must never be modified by Sidekick.** The
  plugin-managed copy is strictly a fallback.
- #14 is the slice that should get its own `/security-review` round; the split exists
  precisely so that review isn't diluted.

## Related wiki docs

- [`wiki/technical-implementation-guide.md`](../technical-implementation-guide.md) — section 8
  ("Copilot CLI") describes the CLI as a first-class runtime input; this decision explains how
  Sidekick will find or supply it.
- The runtime manager is unrelated to the vault-local `sidekick/` customization model
  documented in [`wiki/ai-customization-guide.md`](../ai-customization-guide.md) — that's a
  product feature parsed at runtime, not the CLI-delivery mechanism.
