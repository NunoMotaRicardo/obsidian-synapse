# Synapse (obsidian-synapse)

Obsidian desktop plugin embedding a Claude-native AI assistant (chat panel, editor actions,
triggers, Telegram bot). Forked from the unmaintained obsidian-sidekick; renamed to
**Synapse** — see `.docs/decisions/2026-06-28-claude-agent-sdk-migration.md`.

## Stack & build

- TypeScript (strict) → single `main.js` via esbuild. Node/Electron APIs allowed (desktop-only).
- `npm run build` = `tsc -noEmit -skipLibCheck` + production bundle. `npm run dev` = watch.
- `npm run lint` (eslint + eslint-plugin-obsidianmd).
- Key dependency: `@anthropic-ai/claude-agent-sdk` (0.3.x). It talks JSON-RPC to a system-installed
  `claude` CLI. SDK type reference lives in `node_modules/@anthropic-ai/claude-agent-sdk/dist/*.d.ts`
  and see `.claude/skills/claude-agent-sdk-reference/`.

## Architecture

Read `.docs/architecture.md` first; one spec per module in `.docs/specs/`. Rules:

- **All SDK access goes through the single service in `src/agentService.ts`** (`AgentService`). Other modules import
  SDK types only via its re-exports.
- `src/main.ts` stays lifecycle-only. UI in `src/view/*` + `src/modals/*`, editor features in
  `src/editor/*`, vault config writing in `src/configWriter.ts`, session config assembly in
  `src/view/sessionConfig.ts`, settings/secrets in `src/settings.ts`.
- Update the matching spec in the same change that alters module behavior.

## Workflow

- Work items are GitHub issues on the repo `origin` points to (`gh issue list/view/create/edit`);
  `in-progress` label marks active work. Run `/synapse-build <#N | "description">` for the full
  plan→code→review→PR cycle, or `/synapse-lite "description"` for a quick one-pass change (still
  build/lint/deploy-test, opens a draft PR). See
  `.docs/decisions/2026-06-14-github-issue-workflow.md`.
- Verify changes with the **deploy-test** skill: build → copy artifacts to
  `D:\nmr-obsidian\obsidian-configs\.obsidian\plugins\synapse\` → reload
  (`obsidian plugin:reload id=synapse`). That vault is the user's real vault — deploy only
  builds that compile clean.
- Releases (BRAT): the **release** skill. Tag = `manifest.json` version, no `v` prefix.

## Dev workflow: agents & skills

The dev workflow lives in `.claude/` (canonical, Claude-first). Only one bespoke **agent**
remains; the rest are **skills** run in the main thread (warm context, no cold-start re-derivation):

- **synapse-coder** (`.claude/agents/synapse-coder.md`) — the one spawned agent. Implements one issue
  (full mode) or one description (lite mode) in small, verified increments (build + lint +
  deploy-test), on a `claude/<slug>` branch. Isolated because implementation is long and noisy.
- **synapse-technical-planner** (skill) — audits `.docs/specs/`/`src/` against a request, creates/scopes a
  GitHub issue, splits oversized work. Owns `.docs/specs/<module>.md`. Heavy audits → spawn a generic
  `Explore` agent for the read-only sweep.
- **synapse-reviewer** (skill) — diff-only quality + security gate (`/code-review` +
  `/security-review`), verdict + PR description draft.
- **synapse-analyst** (skill) — synthesizes `grill-me`/`brainstorm` sessions and librarian work into
  `.docs/decisions/` (decision records) and `wiki/` (guides). Hands functional intent to the planner.

Orchestrated by `/synapse-build` (planner skill → synapse-coder agent → reviewer skill loop → PR) and
`/synapse-lite` (coder agent only, draft PR). Live elicitation runs in the main thread; use the
`synapse-analyst` skill afterward to write it up.

**Gemini support (Claude-first):** Gemini reads `GEMINI.md` (which `@`-imports this `CLAUDE.md`)
and `.gemini/commands/*` — thin TOML wrappers that inject the canonical `.claude/skills/`
playbooks via `@{...}`, so nothing is duplicated. See `GEMINI.md`.

> **Don't confuse with the plugin's own feature:** the vault-local `_synapse/` folder
> (`agents/*.md`, `skills/*/SKILL.md`, `.mcp.json`) is a runtime customization model the
> SDK discovers natively as a local plugin — documented in
> `wiki/Customization.md`. The `.claude/` dev tooling above is unrelated tooling for
> working on this repo.

## Conventions

- Tabs for indentation, single quotes, no trailing semicolon omission — match existing files.
- Secrets never go in `data.json` (use localStorage paths already established in settings).
- Register all listeners/intervals through Obsidian `register*` helpers so unload is clean.
- Obsidian UI copy: sentence case, **bold** for literal labels, arrows for navigation.
- Don't rename command IDs, settings keys, or vault-local customization field names without a
  migration path.
- New network access, remote execution, or third-party integration must be user-visible,
  justified, and documented (settings UI + README/spec).
