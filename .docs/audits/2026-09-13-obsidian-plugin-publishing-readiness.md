# Obsidian plugin publishing-readiness audit — 2026-09-13

Scope: the repository at `nunomotaricardo-publishing-readiness-audit`, with focus on the official [Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines), release packaging, `README.md`, and every page in `wiki/`. This is a source review, not a Community Plugins submission review.

## Verdict

**Ready for final release-candidate checks.** The release workflow and metadata are in good shape, and the blocker and major findings below have been resolved. Run the final release gate before submitting to Community Plugins.

## Findings

| Priority | Area | Finding | Recommendation |
|---|---|---|---|
| Resolved blocker | Commands | `src/main.ts` assigned default `Mod+Shift+K`, `Mod+Shift+L`, and `Mod+Shift+E` shortcuts, contrary to Obsidian's recommendation not to set default hotkeys. | Removed the three `hotkeys` properties. Commands remain in the command palette, and users can assign shortcuts in Obsidian. |
| Resolved major | Vault API | `persistToolApprovalRules()` in `src/configWriter.ts` used `vault.adapter.exists()` before calling `vault.modify()`. The guideline prefers the Vault API over the Adapter API. | Replaced the adapter existence check with `getAbstractFileByPath()` while retaining the existing lock; updated `specs/config-writer.md`. |
| Advisory | Adapter exception | `src/vaultPaths.ts` reads the adapter's desktop-local `basePath`. The Claude CLI needs an absolute filesystem path for its working directory and attachments, which does not map to a Vault API abstraction. | Keep this one narrowly scoped desktop-only use. Telegram attachment storage was migrated to Vault APIs (`ensureFolder()`/`createBinary()`). |
| Resolved major | Unload lifecycle | Electron's browser timer returns a numeric handle, but the Agent SDK's `ProcessTransport.close()` unconditionally calls `.unref()` while killing an active CLI subprocess. View disposal can precede `Plugin.onunload()`, so abort-only protection was insufficient. | Install the scoped timer-handle compatibility layer for the plugin lifetime; release its lifecycle reference only after the SDK's 8-second process-cleanup grace window. Two reloads followed by a 9-second wait produced no new `dev:errors` entries. |

## Guideline checks that passed

- `manifest.json` identifies the plugin as **Synapse**, has a desktop-only declaration, an explicit minimum Obsidian version, author information, and a release-compatible semantic version.
- `.github/workflows/release.yml` runs lint, tests, and build; verifies tag/version equality; and attaches exactly `main.js`, `manifest.json`, and `styles.css` to GitHub releases.
- No global `app` instance, `activeLeaf` access, `innerHTML`, `outerHTML`, or `insertAdjacentHTML` use was found in `src/`.
- Custom-view construction does not retain a singleton view reference; `registerView()` creates a new `SynapseView` for each leaf.
- The `SynapseView` vault and workspace listeners use `registerEvent()`, so Obsidian cleans them up with the view.
- Styling is overwhelmingly class-based. The few inline `paddingLeft` values express a dynamic tree depth, which is a reasonable exception to the no-hardcoded-styling guidance.
- Commands use the appropriate regular or editor callbacks, and active editor lookup uses supported workspace APIs.

## Documentation review and updates

A repository-wide documentation review found **no Sidekick, `obsidian-sidekick`, or `_sidekick` references in `README.md` or `wiki/**/*.md`**. The current public installation instructions consistently use the `synapse` plugin id and the Synapse repository.

The following documentation corrections were made in this audit:

- `README.md` no longer tells users to symlink `_synapse/` to `.github/`. That obsolete Copilot-era claim was inaccurate: `_synapse/` configures Synapse sessions only and does not configure Claude Code or VS Code.
- `README.md` now correctly labels the wiki configuration page as a core settings reference.
- `wiki/Configuration.md` now documents the actual five settings tabs: **Claude**, **Feature Map & Agents**, **Capabilities**, **Tools**, and **Bots**. It adds authentication, CLI location, initialization, guardrails, tool-approval, and Telegram safety guidance.
- `wiki/Home.md` now describes Configuration accurately rather than calling it a full reference before it documented every settings tab.

`wiki/Installation.md`, `wiki/Customization.md`, `wiki/Local-Models-Ollama.md`, and `wiki/_Sidebar.md` were checked and need no branding migration. All relative Markdown links in the wiki resolve.

## Suggested release gate

1. Re-run `npm run lint`, `npm test`, and `npm run build` on the final release candidate.
2. Build and reload the plugin in an Obsidian desktop vault; test first launch, authentication, a permission prompt, disable/re-enable, and the configured Telegram bot if it will be advertised.
3. Tag the version without a `v` prefix only after the changelog section and `manifest.json` version are final. The release workflow already enforces the artifact and version contract.

## Validation results

On 2026-09-13, `npm run lint`, `npm test`, and `npm run build` all completed successfully. Vitest ran 415 tests across 23 files; the targeted config-writer suite ran 37 tests. Lint reported two existing warnings and no errors: the deprecated `typescript-eslint` `config` helper in `eslint.config.mts`, and the absence of Obsidian declarative settings definitions in `src/settings.ts`. Neither warning was introduced by this work.

The compiled plugin was deployed to the development vault and reloaded successfully. Telegram attachment storage was verified through its 26-test focused suite after migration to Vault APIs. Following the teardown fix, two plugin reloads followed by a nine-second wait produced no new `dev:errors` entries; earlier errors listed by the CLI predate this verification.

## Sources

- [Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines), accessed 2026-09-13.
- Repository `manifest.json`, `.github/workflows/release.yml`, `src/main.ts`, `src/synapseView.ts`, `src/configWriter.ts`, `src/bots/telegramBot.ts`, `README.md`, and `wiki/`.
