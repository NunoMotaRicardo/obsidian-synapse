# obsidian-copilot (Sidekick fork)

Personal fork of obsidian-sidekick: an Obsidian desktop plugin embedding GitHub Copilot as an
assistant (chat panel, editor actions, ghost text, triggers, Telegram bot). Upstream is
unmaintained; this fork tracks the GA Copilot SDK.

## Stack & build

- TypeScript (strict) → single `main.js` via esbuild. Node/Electron APIs allowed (desktop-only).
- `npm run build` = `tsc -noEmit -skipLibCheck` + production bundle. `npm run dev` = watch.
- `npm run lint` (eslint + eslint-plugin-obsidianmd).
- Key dependency: `@github/copilot-sdk` (1.x, GA). It talks JSON-RPC to a system-installed
  `copilot` CLI (SDK protocol v3; CLI must be ≥ ~1.0.5x). SDK type reference lives in
  `node_modules/@github/copilot-sdk/dist/*.d.ts` — read those before guessing API shapes,
  and see `.claude/skills/copilot-sdk-reference/`.

## Architecture

Read `specs/00-architecture.md` first; one spec per module in `specs/`. Rules:

- **All SDK access goes through `CopilotService` (`src/copilot.ts`).** Other modules import
  SDK types only via its re-exports.
- `src/main.ts` stays lifecycle-only. UI in `src/view/*` + `src/modals/*`, editor features in
  `src/editor/*`, vault config parsing in `src/configLoader.ts`, session config assembly in
  `src/view/sessionConfig.ts`, settings/secrets in `src/settings.ts`.
- Update the matching spec in the same change that alters module behavior.

## Workflow

- Work items are GitHub issues on `NunoMotaRicardo/obsidian-copilot` (`gh issue
  list/view/create/edit`); `in-progress` label marks active work. Run `/sidekick-build <#N |
  "description">` for the full plan→code→review→PR cycle, or `/sidekick-lite "description"` for
  a quick one-pass change (still build/lint/deploy-test, opens a draft PR). See
  `wiki/decisions/2026-06-14-github-issue-workflow.md`.
- Verify changes with `.claude/skills/deploy-test/`: build → copy artifacts to
  `D:\nmr-obsidian\obsidian-configs\.obsidian\plugins\sidekick\` → reload
  (`obsidian plugin:reload id=sidekick`). That vault is the user's real vault — deploy only
  builds that compile clean.
- Releases (BRAT): `.claude/skills/release/`. Tag = `manifest.json` version, no `v` prefix.

## Agents

`.claude/agents/sidekick-*.md` are Claude Code dev-workflow agents for *building* this
plugin, orchestrated by `/sidekick-build` and `/sidekick-lite`:

- **sidekick-analyst** — synthesizes `grill-me` sessions and librarian work into `wiki/`
  (decision records, guides). Hands functional intent to the planner.
- **sidekick-technical-planner** — entry point of `/sidekick-build`: audits `specs/`/`src/`
  against the request, creates or scopes a GitHub issue, and splits oversized work into
  sub-issues. Owns `specs/<module>.md` updates.
- **sidekick-coder** — implements one issue (full mode) or one description (lite mode) at a
  time in small, verified increments (build + lint + deploy-test), on a `claude/<slug>` branch.
- **sidekick-reviewer** — diff-only quality + security gate (`/code-review` +
  `/security-review`), pass/fail verdict and PR description draft; full mode only.

Live elicitation (`grill-me`) runs in the main thread; spawn sidekick-analyst afterwards to
write it up.

> **Don't confuse with the plugin's own feature:** the vault-local `sidekick/` folder
> (`agents/*.agent.md`, `prompts/`, `skills/`, `tools/`, `triggers/`) is a runtime
> customization model parsed by `src/configLoader.ts` — documented in
> `wiki/ai-customization-guide.md`. The `.claude/agents/sidekick-*.md` files above are
> unrelated developer tooling for working on this repo.

## Conventions

- Tabs for indentation, single quotes, no trailing semicolon omission — match existing files.
- Secrets never go in `data.json` (use localStorage paths already established in settings).
- Register all listeners/intervals through Obsidian `register*` helpers so unload is clean.
- Obsidian UI copy: sentence case, **bold** for literal labels, arrows for navigation.
- Don't rename command IDs, settings keys, or vault-local customization field names without a
  migration path.
- New network access, remote execution, or third-party integration must be user-visible,
  justified, and documented (settings UI + README/spec).
