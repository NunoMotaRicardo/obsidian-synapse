# `.docs/` — internal development documentation

This directory holds documentation **for people working on the Synapse codebase**. None of it
ships to end users. User-facing documentation lives in [`wiki/`](../wiki/) at the repo root,
which is mirrored to the GitHub Wiki tab.

`.docs/` is hidden (leading dot) on purpose — it keeps internal/dev material out of casual
browsing of the repo, and out of the way if this repo is ever opened as an Obsidian vault
(Obsidian hides dot-folders). It is tracked normally in git; nothing here is gitignored.

## Layout

```
.docs/
  README.md      ← this file
  architecture.md            ← start here — system overview, promoted from specs/00-architecture.md
  specs/                     ← one file per module, living documentation
    agent-service.md
    chat-view.md
    batch-loops.md
    bots-triggers.md
    config-writer.md
    editor.md
    lock-manager.md
    mcp-bridge.md
    runtime-manager.md
    settings.md
  decisions/                 ← ADRs, date-prefixed, append-only history
  research/                  ← point-in-time investigations: PRDs, spikes, landscape scans
  audits/                    ← point-in-time code/quality audits
  testing/                   ← manual test procedures
  design/                    ← design canvases and mockups
```

## What goes where — and how to keep it that way

- **`architecture.md`** — the single entry point for understanding the system. Read this first.
- **`specs/<module>.md`** — one spec per module in `src/`, kept current. `CLAUDE.md` requires the
  matching spec to be updated in the same change that alters a module's behavior. These are
  **living documents** — if a spec and the code disagree, the spec is stale and needs fixing, not
  archiving.
- **`decisions/`** — architecture decision records, one file per decision, named
  `YYYY-MM-DD-slug.md`. Append-only: once written, a decision record is not edited to match later
  reality — a new record supersedes it instead.
- **`research/`** — point-in-time investigations that informed a decision but are not living
  documentation of current behavior: PRDs for unshipped features, spike write-ups, competitive
  landscape scans, and snapshots of past architecture. If a document in here starts being treated
  as a description of the current system, that's the trap this split is meant to prevent — move
  its still-true content into a spec instead of leaving readers to rediscover it's stale.
- **`audits/`** — point-in-time code or quality audits. Findings age; check whether they're still
  open before acting on one.
- **`testing/`** — manual test procedures that aren't automated (see `test/` for automated tests,
  which this directory does not duplicate or replace).
- **`design/`** — design canvases and visual mockups produced during feature work.

## The rule that keeps this from re-mixing

Nothing in `.docs/` is user-facing. If a document explains how to *use* the plugin (install,
configure, write agents/skills/prompts for `_synapse/`), it belongs in `wiki/`, not here. If a
document explains how the plugin *is built* (architecture, module internals, decisions, audits,
research), it belongs here, not in `wiki/`.

When in doubt: would a plugin user ever need to read this to use Synapse? If yes, `wiki/`. If it's
only useful to someone changing `src/`, `.docs/`.
