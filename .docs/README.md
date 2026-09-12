# `.docs/` — internal development documentation

This directory holds documentation **for people working on the Synapse codebase**. None of it
ships to end users. User-facing documentation lives in [`wiki/`](../wiki/) at the repo root,
which is mirrored to the GitHub Wiki tab.

`.docs/` is hidden (leading dot) on purpose — it keeps internal/dev material out of casual
browsing of the repo, and out of the way if this repo is ever opened as an Obsidian vault
(Obsidian hides dot-folders). It is tracked normally in git; nothing here is gitignored.

The living architecture overview and per-module specs live at the repo root in
[`specs/`](../specs/), not here — they're the entry point for an AI agent or contributor reading
this codebase cold, so they need to be visible without digging into a dot-folder. Everything else
that's specific to *developing* Synapse (decisions, research, audits, manual test procedures,
design canvases) stays in `.docs/`, private to this repo's maintainers.

## Layout

```
.docs/
  README.md      ← this file
  decisions/                 ← ADRs, date-prefixed, append-only history
  research/                  ← point-in-time investigations: PRDs, spikes, landscape scans
  audits/                    ← point-in-time code/quality audits
  testing/                   ← manual test procedures
  design/                    ← design canvases and mockups

specs/                       ← repo root — architecture overview + one file per module
  ARCHITECTURE.md            ← start here — system overview, module table
  agent-service.md
  chat-view.md
  config-writer.md
  editor.md
  lock-manager.md
  runtime-manager.md
  settings.md
  vault-paths.md
  bots.md
```

## What goes where — and how to keep it that way

- **[`specs/ARCHITECTURE.md`](../specs/ARCHITECTURE.md)** — the single entry point for
  understanding the system. Read this first.
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
document describes *current* module behavior (what a module does, its contracts, its
invariants), it belongs in root [`specs/`](../specs/), not here — specs are the one piece of
developer-facing documentation that's public and root-level, because that's what an AI coding
agent or new contributor reads first. Everything else about how the plugin *came to be built*
this way — decisions, research, audits — belongs here, not in `wiki/` or `specs/`.

When in doubt: would a plugin user ever need to read this to use Synapse? If yes, `wiki/`. Would
someone changing `src/` need it to know what a module is supposed to do *right now*? If yes,
`specs/`. Otherwise, `.docs/`.
