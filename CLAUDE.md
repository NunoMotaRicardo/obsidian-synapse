# obsidian-copilot (Sidekick fork)

Personal fork of obsidian-sidekick: an Obsidian desktop plugin embedding an AI assistant (chat
panel, editor actions, triggers, Telegram bot). Upstream is unmaintained. **This repo is being
rebuilt as a Claude-native plugin** (`obsidian-claude-brain`) — see
`wiki/decisions/2026-06-28-claude-agent-sdk-migration.md`. The product rename (the `sidekick`
plugin id, vault folder, command IDs) is deferred and not yet done.

## Stack & build

- TypeScript (strict) → single `main.js` via esbuild. Node/Electron APIs allowed (desktop-only).
- `npm run build` = `tsc -noEmit -skipLibCheck` + production bundle. `npm run dev` = watch.
- `npm run lint` (eslint + eslint-plugin-obsidianmd).
- **Migrating to the Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — see
  `.claude/skills/claude-agent-sdk-reference/` and the migration decision record. Until the engine
  swap lands, the code still uses the Copilot SDK below.
- Current dependency: `@github/copilot-sdk` (1.x, GA). It talks JSON-RPC to a system-installed
  `copilot` CLI (SDK protocol v3; CLI must be ≥ ~1.0.5x). SDK type reference lives in
  `node_modules/@github/copilot-sdk/dist/*.d.ts` — read those before guessing API shapes,
  and see `.claude/skills/copilot-sdk-reference/` (transitional).

## Architecture

Read `specs/00-architecture.md` first; one spec per module in `specs/`. Rules:

- **All SDK access goes through the single service in `src/copilot.ts`** (today `CopilotService`;
  becoming `AgentService` in the migration). Other modules import SDK types only via its
  re-exports.
- `src/main.ts` stays lifecycle-only. UI in `src/view/*` + `src/modals/*`, editor features in
  `src/editor/*`, vault config parsing in `src/configLoader.ts`, session config assembly in
  `src/view/sessionConfig.ts`, settings/secrets in `src/settings.ts`.
- Update the matching spec in the same change that alters module behavior.

## Workflow

- Work items are GitHub issues on `NunoMotaRicardo/obsidian-claude-brain` (the repo `origin`
  points to; `gh issue list/view/create/edit`); `in-progress` label marks active work. Run
  `/brain-build <#N | "description">` for the full plan→code→review→PR cycle, or
  `/brain-lite "description"` for a quick one-pass change (still build/lint/deploy-test, opens a
  draft PR). See `wiki/decisions/2026-06-14-github-issue-workflow.md`.
- Verify changes with `.claude/skills/deploy-test/`: build → copy artifacts to
  `D:\nmr-obsidian\obsidian-configs\.obsidian\plugins\sidekick\` → reload
  (`obsidian plugin:reload id=sidekick`). That vault is the user's real vault — deploy only
  builds that compile clean. (The `sidekick` plugin id is unchanged pending the product rename.)
- Releases (BRAT): `.claude/skills/release/`. Tag = `manifest.json` version, no `v` prefix.

## Dev workflow: agents & skills

The dev workflow lives in `.claude/` (canonical, Claude-first). Only one bespoke **agent**
remains; the rest are **skills** run in the main thread (warm context, no cold-start re-derivation):

- **brain-coder** (`.claude/agents/brain-coder.md`) — the one spawned agent. Implements one issue
  (full mode) or one description (lite mode) in small, verified increments (build + lint +
  deploy-test), on a `claude/<slug>` branch. Isolated because implementation is long and noisy.
- **brain-technical-planner** (skill) — audits `specs/`/`src/` against a request, creates/scopes a
  GitHub issue, splits oversized work. Owns `specs/<module>.md`. Heavy audits → spawn a generic
  `Explore` agent for the read-only sweep.
- **brain-reviewer** (skill) — diff-only quality + security gate (`/code-review` +
  `/security-review`), verdict + PR description draft.
- **brain-analyst** (skill) — synthesizes `grill-me`/`brainstorm` sessions and librarian work into
  `wiki/` (decision records, guides). Hands functional intent to the planner.

Orchestrated by `/brain-build` (planner skill → brain-coder agent → reviewer skill loop → PR) and
`/brain-lite` (coder agent only, draft PR). Live elicitation runs in the main thread; use the
`brain-analyst` skill afterward to write it up.

**Gemini support (Claude-first):** Gemini reads `GEMINI.md` (which `@`-imports this `CLAUDE.md`)
and `.gemini/commands/*` — thin TOML wrappers that inject the canonical `.claude/skills/`
playbooks via `@{...}`, so nothing is duplicated. See `GEMINI.md`.

> **Don't confuse with the plugin's own feature:** the vault-local `sidekick/` folder
> (`agents/*.agent.md`, `prompts/`, `skills/`, `tools/`, `triggers/`) is a runtime
> customization model parsed by `src/configLoader.ts` — documented in
> `wiki/ai-customization-guide.md`. The `.claude/` dev tooling above is unrelated tooling for
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
