# Claude Synapse (claude-synapse)

Obsidian desktop plugin embedding a Claude-native AI assistant (chat panel, vault search,
editor actions, Telegram bot). See `.docs/decisions/2026-06-28-claude-agent-sdk-migration.md` for the
Claude Agent SDK architecture decision.

## Stack & build

- TypeScript (strict) → single `main.js` via esbuild. Node/Electron APIs allowed (desktop-only).
- `npm run build` = `tsc -noEmit -skipLibCheck` + production bundle. `npm run dev` = watch.
- `npm run lint` (eslint + eslint-plugin-obsidianmd).
- Key dependency: `@anthropic-ai/claude-agent-sdk` (0.3.x). It talks JSON-RPC to a system-installed
  `claude` CLI. SDK type reference lives in `node_modules/@anthropic-ai/claude-agent-sdk/dist/*.d.ts`
  and the `synapse:claude-agent-sdk-reference` skill (installed via the synapse plugin, not vendored in this repo).

## Architecture

Read [`specs/ARCHITECTURE.md`](specs/ARCHITECTURE.md) first; one spec per module in
[`specs/`](specs/) — these are checked into the repo root (not `.docs/`) so external AI agents
and contributors can find them without digging. Rules:

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
- Verify changes with the **deploy-test** skill: build → copy `main.js`, `manifest.json`,
  `styles.css` to the test vault's plugin folder → reload the plugin. Always pass `vault=` to the
  `obsidian` CLI (otherwise it targets the focused vault), and enable **Settings → General →
  Advanced → Command line interface** in Obsidian. Pick the platform you are on:
  - **Windows:** vault `$env:SYNAPSE_DEV_VAULT` or default
    `D:\nmr-obsidian\obsidian-configs\.obsidian\plugins\synapse\`; reload by re-enabling via
    `obsidian vault=obsidian-configs eval …`. That vault is the user's real vault — deploy only
    builds that compile clean.
  - **Linux / Omarchy:** disposable vault `$SYNAPSE_DEV_VAULT` or default
    `/data/dev-obsidian/vault_test` (plugin folder `.obsidian/plugins/claude-synapse/`, the
    `manifest.json` id; open the vault once with community plugins turned on); reload with
    `electron43 /usr/lib/obsidian/app.asar vault=vault_test plugin:reload id=claude-synapse`, then
    `… eval …`. Don't use the `/usr/bin/obsidian` wrapper for CLI calls: it injects
    `~/.config/obsidian/user-flags.conf` flags before the arguments, so Obsidian reads
    `-disable-gpu` as the command (`Command "-disable-gpu" not found`). In Obsidian's "Set up CLI"
    dialog choose **Skip** (registration fails because the process is named `electron`).
    Never write to the user's real vaults on Linux (e.g. `~/Cloud/onedrive/vault_nmr`).
- Releases (Obsidian Community directory and BRAT both install from GitHub releases): the
  **release** skill. Tag = `manifest.json` version, no `v` prefix.

## Dev workflow: agents & skills

The dev workflow lives in `.claude/` (canonical, Claude-first). There are no bespoke **agents**:
the workflow roles are **skills** run in the main thread (warm context, no cold-start re-derivation),
plus one delegated role:

- **Coder** (a general-purpose subagent on Sonnet, briefed by
  [`.claude/skills/synapse-build/coder-brief.md`](.claude/skills/synapse-build/coder-brief.md)):
  implements one issue (full mode) or one description (lite mode) in small, verified increments
  (build + lint + test + deploy-test), on a `claude/<slug>` branch. Delegated because
  implementation is long and noisy; review rounds resume the same subagent with `SendMessage`.
- **synapse-technical-planner** (skill) — audits `specs/`/`src/` against a request, creates/scopes a
  GitHub issue, splits oversized work. Owns `specs/<module>.md`. Heavy audits → spawn a generic
  `Explore` agent for the read-only sweep.
- **synapse-reviewer** (skill) — diff-only quality + security gate (`/code-review` +
  `/security-review`), verdict + PR description draft.
- **synapse-analyst** (skill) — synthesizes `grill-me`/`brainstorm` sessions and librarian work into
  `.docs/decisions/` (decision records) and `wiki/` (guides). Hands functional intent to the planner.

Orchestrated by `/synapse-build` (planner skill → coder subagent → reviewer skill loop → PR) and
`/synapse-lite` (coder subagent only, draft PR). Live elicitation runs in the main thread; use the
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
