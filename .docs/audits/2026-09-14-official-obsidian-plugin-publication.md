# Official Obsidian plugin publication audit and plan — 2026-09-14

## Executive summary

**Verdict: not ready to submit yet.** The codebase, public repository, tests, and release packaging are substantially prepared, but publication is blocked by a namespace collision: the official directory already contains a plugin whose `id` is `synapse` and whose name is **Synapse**. Both must be unique. The plugin needs a new public name and ID before submission.

The strongest available candidate at the time of this audit is:

- Name: **Claude Synapse**
- ID: `claude-synapse`

Neither appeared in the live directory on 2026-09-14. Availability must be checked again immediately before committing the rename. The rename should happen before the first official-directory release because an ID is also the installed plugin folder name and is costly to change after publication.

After the rename, the principal work is disclosure and release hardening rather than architectural rework: complete the README's required network/account/outside-vault disclosures, resolve stale security documentation, clarify licensing and upstream adaptation status, fix the release automation failure, run a reproducible release-candidate scan, and submit through `community.obsidian.md`.

## Scope and evidence

This audit covers:

- The local checkout at commit `7919d05` on 2026-09-14.
- The public GitHub repository and its default branch.
- The live Community Plugins registry.
- Release `0.1.1` and recent GitHub Actions runs.
- Obsidian's current developer documentation and official sample plugin.

The local checkout was behind the public default branch during the audit: local metadata was at `0.1.0`, while GitHub `main`, `versions.json`, and the latest release were at `0.1.1`. Repository conclusions that depend on release state use the public GitHub state; local lint/test/build results use the checked-out source.

A previous audit, [`2026-09-13-obsidian-plugin-publishing-readiness.md`](2026-09-13-obsidian-plugin-publishing-readiness.md), remains useful for code-guideline details. This report supersedes its overall “ready for final release-candidate checks” verdict because it checks the live directory namespace and the current submission system.

## What publishing currently requires

The current submission process is web-based, not a pull request to `obsidianmd/obsidian-releases`:

1. Prepare a public GitHub repository and a published GitHub release.
2. Sign in at [community.obsidian.md](https://community.obsidian.md) and connect GitHub.
3. Open **Plugins → New plugin**.
4. Submit the repository URL, select the owning account, accept the developer policies, and make the maintenance commitment.
5. Resolve automated scan errors and publish the listing.

The `obsidian-releases` repository is now an hourly mirror of directory data; its old PR route is not the documented submission mechanism.

### Repository and release contract

The repository must expose reviewable source and contain at its root:

- `README.md` explaining purpose and usage.
- A clearly identifiable license.
- `manifest.json`.

The default branch's manifest is authoritative. It must have valid `author`, `minAppVersion`, `name`, `version`, `id`, `description`, and `isDesktopOnly` fields. The ID must be unique, lowercase letters/hyphens only, must not contain `obsidian`, and must not end in `plugin`.

The published release must:

- Use a tag exactly equal to the manifest's semantic version, without a `v` prefix.
- Attach `main.js`, `manifest.json`, and `styles.css` when the plugin uses CSS.
- Not remain a draft.

The directory scans the manifest, release assets, source, and whether the distributed build matches the source. Errors block installation. Correcting a released error requires a version bump and a new release. The scanner executes the first available package script in this order: `build`, `build:plugin`, `compile`; that script must terminate and produce the production bundle.

### Policy disclosures

The README must clearly disclose, where applicable:

- Required accounts and payments.
- Every remote/network service and why it is contacted.
- File access outside the vault and why it is needed.
- Server-side telemetry and a privacy-policy link.
- Advertising or closed-source components.

Client-side telemetry, concealed/obfuscated behavior, dynamic internet advertising, and runtime self-installation or dependency updates are prohibited.

Node/Electron use requires `isDesktopOnly: true`. Mobile support is not required when this classification is accurate.

## Repository findings

### Blockers

| # | Finding | Evidence | Required action |
|---|---|---|---|
| B1 | Plugin ID collision | The live registry already contains `dustinkeeton/obsidian-synapse` with ID `synapse`. This repository's `manifest.json` also uses `synapse`. | Select a unique ID. `claude-synapse` was available on 2026-09-14. Recheck before committing. |
| B2 | Plugin name collision | The same directory entry is named **Synapse**. Obsidian requires unique plugin names. | Select a unique compliant name. **Claude Synapse** was available on 2026-09-14. |
| B3 | Required disclosures are incomplete as one reviewable declaration | The README explains Claude CLI, Anthropic/Ollama, MCP, and Telegram separately, but does not provide a complete policy-oriented inventory of accounts, payments, network destinations, subprocesses, or outside-vault filesystem access. The code can call Anthropic-compatible endpoints and Telegram, launches the Claude CLI, uses temporary attachment files, and supports agent/MCP tool execution. | Add a concise **Privacy, network access, and external processes** section naming each service/capability, when it activates, data sent, account/payment requirements, and outside-vault access. State explicitly whether Synapse itself collects telemetry. Link `SECURITY.md`. |
| B4 | Release automation is not currently trustworthy | Release `0.1.1` has the correct three assets and matching manifest, but its tag-triggered **Release** workflow ended in `startup_failure` with no jobs. The release exists, apparently through another/manual path. | Diagnose the workflow startup failure, exercise the workflow on the renamed release candidate, and verify artifact/source reproducibility before submission. |

### High-priority readiness work

| # | Finding | Evidence | Improvement |
|---|---|---|---|
| H1 | A rename affects existing BRAT users and persisted state | The ID determines the plugin install folder. Secure fields use local-storage-backed paths and code already contains legacy-prefix migration logic. | Inventory every ID/name-derived key, folder, command, URI, CSS class, release instruction, and test. Preserve command IDs and settings keys where possible. Publish explicit BRAT migration steps and test retention of settings/secrets. |
| H2 | Security documentation contains stale implementation references | `SECURITY.md` refers to `src/mcpBridge.ts`, which no longer exists, while MCP execution is now provided through the Claude Agent SDK. It also says BRAT is the only distribution route. | Update the threat model to current SDK behavior and planned Community Plugins distribution. Verify every capability statement against current code. |
| H3 | The adaptation/fork status needs an acceptance record | README and licensing state that Synapse began as an adaptation of `obsidian-sidekick`. Obsidian applies special acceptance rules to forks and requires upstream credit. Credit is present, but this audit found no public upstream approval record. | Determine whether Obsidian will classify the project as a fork. If so, obtain and link explicit public approval from the original author, or document why the repository is an independent derivative rather than a maintained fork. Keep all required Apache attribution. |
| H4 | License scanning is ambiguous | `LICENSE.md` combines an MIT grant with a third-party Apache notice. GitHub reports the repository license as `NOASSERTION`/Other, although `NOTICE` and `LICENSES/Apache-2.0.txt` exist. Obsidian's scanner uses GitHub license detection and may warn. | Make the primary project license scanner-friendly without dropping derivative-work notices—for example, a conventional root `LICENSE` for the project license plus the existing `NOTICE` and `LICENSES/`. Confirm the legally correct layout before changing it. |
| H5 | Default branch and release state were not aligned in the audit checkout | Local files report `0.1.0`; public `main` and release assets report `0.1.1`. | Start publication work from the current default branch and verify that the submitted manifest, tag, source tree, `versions.json`, and release asset are byte-for-byte coherent. |

## Code lineage and similarity audit — 2026-09-14

Two independent, read-only comparisons assessed the current Claude Synapse code against
[`vieiraae/obsidian-sidekick`](https://github.com/vieiraae/obsidian-sidekick). The comparison used
Claude Synapse merge commit [`46eb361`](https://github.com/NunoMotaRicardo/obsidian-synapse/commit/46eb361b65a82f9438ac9446f94fbb63cc455ddb)
(PR #258; its head was `4179438`) and Sidekick commit
[`256a43b`](https://github.com/vieiraae/obsidian-sidekick/commit/256a43bd08099e90c7ff1c65f1e343af51324a4d).
Generated bundles, dependencies, lockfiles, binary assets, vendored licenses, and documentation were
excluded from the quantitative source comparison.

### Method and quantitative result

The comparison inventoried same-path source/configuration files, checked exact Git blob hashes,
compared ordered nonblank/non-comment line sequences with Python `difflib.SequenceMatcher`, and
calculated lexical token-set Jaccard similarity. These metrics are heuristic: they describe static
similarity and cannot by themselves prove authorship, copying, copyright status, or a legal
relationship.

| Measure | Result |
|---|---:|
| Claude Synapse files in scope | 51 |
| Sidekick files in scope | 38 |
| Same relative paths | 31 |
| Same-path overlap, as a share of Claude Synapse scope | 60.8% |
| Same-path overlap, as a share of Sidekick scope | 81.6% |
| Overlapping TypeScript source paths | 24 |
| Matched normalized TypeScript lines | 3,721 of 7,680 Synapse / 6,834 Sidekick lines |
| Aggregate ordered-line similarity across shared TypeScript files | 51.3% |
| Aggregate token-set Jaccard across shared TypeScript files | 54.8% |
| Byte-identical source files | 3 |

The byte-identical files are `src/bots/index.ts`, `src/bots/types.ts`, and `src/debug.ts`. Those
small files are weak evidence by themselves. Stronger evidence comes from long exact blocks in
nontrivial product behavior:

| File | Ordered-line similarity | Token Jaccard | Representative overlap |
|---|---:|---:|---|
| `src/tasks.ts` | 98.9% | 99.1% | Lines 4–98 match at the compared revisions. |
| `src/bots/telegramApi.ts` | 92.5% | 85.3% | Synapse lines 5–135 match Sidekick lines 5–135; another large block follows. |
| `src/modals/vaultScopeModal.ts` | 92.3% | 97.5% | Synapse lines 172–292 match Sidekick lines 168–288. |
| `src/modals/folderTreeModal.ts` | 88.8% | 98.1% | Multiple exact blocks, including lines 1–27 and 113–143. |
| `src/modals/elicitationModal.ts` | 88.6% | 95.5% | Multiple exact blocks of interaction logic. |
| `src/modals/editModal.ts` | 82.5% | 87.2% | Synapse and Sidekick lines 9–74 match. |
| `src/bots/telegramBot.ts` | 74.6% | 70.4% | Long matching Telegram-processing blocks. |
| `src/editor/editorMenu.ts` | 56.2% | 66.9% | Long matching editor-action blocks. |
| `src/main.ts` | 56.4% | 50.7% | Shared lifecycle and feature-wiring blocks remain. |

Common Obsidian tooling can explain high similarity in `tsconfig.json`, `esbuild.config.mjs`, and
parts of the manifest. It does not explain the near-identical task abstraction or the long matching
Telegram, modal, vault-scope, folder-tree, and editor-action implementations.

### Repository-history evidence

The earliest substantive Claude Synapse commit,
[`960a2ac`](https://github.com/NunoMotaRicardo/obsidian-synapse/commit/960a2ace662d2251f9857f2413d3457f2cc61786),
states that it contains the “Sidekick (obsidian-copilot fork) codebase at the start of the migration
to the Claude Agent SDK.” Its initial tree contained `src/copilot.ts`, `src/sidekickView.ts`,
`src/configLoader.ts`, `src/editor/ghostText.ts`, `src/triggerScheduler.ts`, Sidekick-branded starter
content, and the same distinctive editor, modal, view, Telegram, task, and configuration module
families.

Commit [`6fef5ee`](https://github.com/NunoMotaRicardo/obsidian-synapse/commit/6fef5eea963d41bec3a303e0d50fb825bbc4cae8)
then records the deliberate engine replacement: the GitHub Copilot SDK service was rewritten around
the Claude Agent SDK, with a new session wrapper and changes across the view, bot, search, settings,
and editor consumers. From the initial snapshot through `46eb361`, the repository records 196
changed files, 28,243 insertions, and 15,980 deletions.

The current architecture has substantial original divergence, including `src/agentService.ts`,
`src/runtimeManager.ts`, `src/configWriter.ts`, `src/session.ts`, `src/permissions.ts`,
`src/providerModels.ts`, `src/sdkShims.ts`, `src/vaultPaths.ts`, `src/taskPlanTracker.ts`, and the
Claude-specific view/session implementation. Sidekick retains modules that have no same-path
current Synapse equivalent, including `src/copilot.ts`, `src/configLoader.ts`,
`src/sidekickView.ts`, `src/editor/ghostText.ts`, `src/triggerScheduler.ts`, and
`src/view/triggersPanel.ts`.

### Finding

The evidence supports this factual description with high confidence:

> Claude Synapse is a substantially re-engineered adaptation/continuation of Sidekick, rebuilt
> around the Claude Agent SDK.

The repositories are **not GitHub forks in the platform-metadata or shared-history sense**: both
report `fork=false`, and the current repositories do not expose shared Git ancestry. However, the
initial-commit statement, distinctive shared architecture, exact source blocks, and approximately
51% aggregate shared-TypeScript line similarity contradict a factual claim that the relationship is
solely conceptual inspiration with no inherited implementation.

This is a technical provenance finding, not a legal conclusion and not by itself a determination of
how Obsidian will apply its Community-directory fork policy. A more exact file-by-file lineage would
require the full historical `NunoMotaRicardo/obsidian-copilot` repository referenced by the initial
commit. Until Obsidian classifies the repository, the safest publication statement is the precise
one above rather than either “GitHub fork” or “inspired solely by.” Existing Apache attribution must
remain regardless of policy classification.

### Recommended quality improvements

| # | Finding | Evidence | Improvement |
|---|---|---|---|
| R1 | The manifest copy may attract scanner/style feedback | The current name collides. The description uses an em dash; guidance advises plain, action-oriented copy without unsupported special characters. The product's defining advantages are its native Claude Agent SDK foundation and tight integration with the Obsidian UI. | Rename the plugin to **Claude Synapse** / `claude-synapse`. Write concise copy that leads with native Claude agents inside Obsidian without implying Anthropic ownership or endorsement. Keep the description under 250 characters and end it with a period. |
| R2 | Lint is error-free but not warning-free | `npm run lint` reports two warnings: deprecated `typescript-eslint` config usage and missing `PluginSettingTab.getSettingDefinitions()` support. The manifest requires Obsidian 1.13.0, where settings search is available. | Adopt `defineConfig()` and declarative setting definitions, or document why the latter cannot yet be adopted. Prefer zero findings before requesting review. |
| R3 | Release notes and version history are incomplete | Public release `0.1.1` says only “Maintenance release,” while the local changelog visible during the audit listed only `0.1.0`. | Ensure `CHANGELOG.md` on the publication branch describes every public version and that release notes explain user-visible changes. |
| R4 | Repository discoverability can improve | GitHub topics were empty and no homepage was set. | Add focused topics such as `obsidian-plugin`, `claude`, and `ai-assistant`; optionally set the project/documentation homepage. Not a publication gate. |
| R5 | Branch protection was absent | GitHub reported no required checks/reviews on `main`. | Require the existing CI and CodeQL checks before merging publication/release changes. This is maintenance hardening, not an Obsidian requirement. |
| R6 | Build provenance can be stronger | The release assets are valid and approximately 2 MB for `main.js`, but the workflow does not create the build attestations shown by the current sample plugin. | Consider GitHub artifact attestations after the release workflow is reliable. This is recommended, not mandatory. |

## Checks that already pass

- The repository is public and exposes TypeScript source.
- `manifest.json` includes all required fields and correctly sets `isDesktopOnly: true` for Node/Electron use.
- `minAppVersion` and semantic version formatting are valid.
- Public release `0.1.1` is published, uses an exact non-`v` tag, and contains `main.js`, `manifest.json`, and `styles.css`.
- Public `versions.json` maps both `0.1.0` and `0.1.1` to Obsidian `1.13.0`.
- `package.json` provides a terminating production `build` command.
- Runtime dependencies are bundled rather than installed by the plugin at runtime.
- The README provides substantial setup, usage, safety, attribution, and support documentation.
- `SECURITY.md`, `NOTICE`, third-party license text, contribution guidance, issue templates, tests, CI, CodeQL, Dependabot security updates, secret scanning, and push protection are present.
- The source uses Obsidian `requestUrl` for direct HTTP requests found in the audit.
- No `innerHTML`, `outerHTML`, or `insertAdjacentHTML` usage was found in `src/`.
- The prior code-guideline audit found lifecycle registration, command callbacks, view construction, and the necessary narrow desktop Adapter use acceptable.
- Local validation on 2026-09-14 passed: 23 test files and 416 tests; TypeScript and production build succeeded; lint had zero errors and the two warnings listed above.

## Plan to publication

### Phase 1 — Claim a stable identity

**Goal:** remove the hard namespace blocker before accumulating more release history.

1. Recheck the live directory for `claude-synapse` and **Claude Synapse**.
2. Make and record the final naming decision.
3. Map all rename impacts: manifest ID/name, package metadata, local storage, installation folder, tests, docs, screenshots, release workflow, BRAT instructions, and any external links.
4. Implement migration behavior/instructions for current BRAT users.

**Exit criteria:** unique compliant name/ID, complete rename inventory, and a tested migration path.

### Phase 2 — Close policy and documentation gaps

**Goal:** make every privileged behavior understandable before install.

1. Add a single README disclosure section covering:
   - Claude account/subscription and optional Anthropic API charges.
   - Claude CLI installation and local subprocess execution.
   - Anthropic and configured Messages API endpoints.
   - Ollama/local endpoint behavior.
   - Telegram API and what vault content can be sent.
   - MCP servers and arbitrary local-process/tool capability.
   - Temporary/outside-vault filesystem access and user-selected working directories.
   - Telemetry status and applicable external providers' privacy policies.
2. Correct `SECURITY.md` to the current SDK architecture and directory status.
3. Resolve/document the `obsidian-sidekick` fork-policy question and retain attribution.
4. Make licensing scanner-friendly after confirming the proper legal structure.
5. Update changelog, installation guide, screenshots, and all old-name instructions.

**Exit criteria:** a reviewer can identify every account, payment, network destination, executable, filesystem boundary, and high-risk mode from the README and linked security policy.

### Phase 3 — Produce a clean release candidate

**Goal:** create one source/release state that the scanner can reproduce.

1. Work from current `main`; bump to a new prerelease-candidate source version only when the rename and disclosures are final.
2. Resolve both lint warnings if feasible.
3. Run `npm ci`, `npm run lint`, `npm run test`, and `npm run build` from a clean checkout.
4. Deploy-test in Obsidian Desktop:
   - clean install and first launch;
   - Claude CLI discovery and authentication;
   - API-key and local endpoint paths;
   - tool approval and denial;
   - write/edit operations;
   - disable/re-enable and restart;
   - BRAT upgrade/migration from `synapse` to the new ID;
   - Telegram and MCP flows if advertised at launch.
5. Compare the generated `main.js`, `manifest.json`, and `styles.css` with the intended release assets.
6. Fix the tag-triggered Release workflow. Optionally add provenance attestations.

**Exit criteria:** clean reproducible build, all tests pass, manual smoke matrix passes, migration works, release workflow completes successfully.

### Phase 3 execution record — 2026-09-14

The `0.1.1` tag's **Release** run (`34790291130`) started and completed at the same timestamp
with no jobs or logs. GitHub's REST API exposes no run timing, check-run diagnostic, or downloadable
log for it. The same `startup_failure` occurred simultaneously for independent **CI** and **Wiki
sync** runs (`34790289671`, `34789905952`, `34789847133`, `34789846694`), while subsequent runs
with the same runner/action configuration succeeded. This is consistent with a transient GitHub
Actions startup failure; the exact root cause is unavailable from the retained GitHub evidence.
The existing `0.1.1` assets were published through a separate/manual path.

The renamed candidate is version `0.1.2`; it intentionally does not reuse the published `0.1.1`
tag because that release's manifest identifies the historical `synapse` plugin. The release workflow
now makes the platform-independent release contract explicit: after a clean build it validates the
exact non-`v` semantic tag against `package.json`, `manifest.json`,
`versions.json`, and the changelog; records SHA-256 hashes for exactly `main.js`, `manifest.json`,
and `styles.css`; transfers the verified build through an Actions artifact to a separate publishing
job; re-verifies that downloaded build; creates a **draft** release using only those assets; downloads
the draft assets and compares their hashes; preserves verification evidence; then publishes only if
the comparison succeeds. Per-tag concurrency and draft-ID tracking clean up only a failed run's own
draft, never a tag or a pre-existing release. The verification report is retained as an Actions
artifact, not a release asset.

These checks have been validated locally against the generated candidate artifact only. A successful
matching-tag workflow run and a check of downloaded public release assets are impossible until a
maintainer pushes a new exact-version tag; neither has been performed or claimed. The next
maintainer-created version/tag must exercise this workflow before Community submission; no existing
tag or public release is rewritten.

**Maintainer checklist before Phase 4:**

- [ ] Re-run clean install, lint, tests, and production build on the final release commit.
- [ ] Run the desktop smoke and migration matrix in a clean vault and record results in #256.
- [ ] Confirm `package.json`, `manifest.json`, `versions.json`, `CHANGELOG.md`, and the intended
  non-`v` tag all have the same version/minimum-app mapping.
- [ ] Protect the default branch and create the exact-version tag only from a commit already merged
  into it. Do not move, replace, or reuse a release tag. Lightweight and annotated tags are both
  supported, but their peeled commit must equal the push event and checked-out commit.
- [ ] Push a new exact-version tag; wait for the Release workflow to verify tag identity and
  default-branch ancestry before publishing its verified release.
- [ ] Download the public assets and install them into a fresh vault before using the Community portal.
- [ ] Do not publish to the Community portal until the upstream attribution/approval blocker is resolved.

### Phase 4 — Publish the submission release

**Goal:** create the exact artifacts the Community directory will install.

1. Commit the final manifest to default branch.
2. Update `versions.json` if `minAppVersion` changes.
3. Tag with the exact manifest version, with no `v` prefix.
4. Publish—not draft—a GitHub release containing exactly the required artifacts.
5. Download the published assets and verify their version, checksums, and startup behavior in a fresh vault.

**Exit criteria:** public default branch, tag, source, and release assets agree; release is installable from GitHub alone.

### Phase 5 — Submit and clear review

**Goal:** achieve an installable Community Plugins listing.

1. Sign in at [community.obsidian.md](https://community.obsidian.md) and link the maintainer's GitHub account.
2. Open **Plugins → New plugin**, submit the repository URL, select the owner, accept policies, and confirm maintenance responsibility.
3. Review every manifest, release, source, and build result.
4. Treat all errors as blockers and clear warnings where practical.
5. For a released fix, increment the version and publish a new matching release; use **Request review** to rescan.
6. Publish the listing when the management UI allows it.
7. Verify discovery and installation from a clean Obsidian profile.

**Exit criteria:** the renamed plugin appears in Community Plugins and installs, enables, authenticates, and completes a permission-gated smoke task.

### Phase 6 — First-week operations

1. Monitor GitHub issues, directory scan status, crash/auth reports, and release downloads daily.
2. Keep a rollback/hotfix version ready; never replace assets under an existing tag.
3. Publish fixes as new semantic versions with matching tags and assets—do not resubmit the plugin.
4. Recheck disclosures whenever adding a provider, endpoint, executable, telemetry, payment, or outside-vault access.

## Suggested issue breakdown

1. **Rename plugin for Community directory uniqueness** — decision, code/docs migration, BRAT upgrade test.
2. **Add publication policy disclosures and refresh security documentation** — README disclosure matrix, threat model, provider privacy links.
3. **Resolve upstream adaptation and license scanner status** — public permission/status record and conventional license layout.
4. **Harden official release pipeline** — diagnose startup failure, reproducible clean build, asset verification, optional attestations.
5. **Run Community directory release candidate and submit** — full test matrix, final release, web submission, scanner remediation.

Issues 1–3 can be prepared in parallel after the name is chosen. Issue 4 depends on the final identity/release metadata. Issue 5 depends on all preceding work.

## Authoritative sources

- [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin) ([source](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Submit%20your%20plugin.md))
- [Set up and claim](https://docs.obsidian.md/Community+directory/Set+up+and+claim) ([source](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Community%20directory/Set%20up%20and%20claim.md))
- [Submission requirements for plugins](https://docs.obsidian.md/Community+directory/Submission+requirements+for+plugins) ([source](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Community%20directory/Submission%20requirements%20for%20plugins.md))
- [Developer policies](https://docs.obsidian.md/Developer+policies) ([source](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Community%20directory/Developer%20policies.md))
- [Manifest reference](https://docs.obsidian.md/Reference/Manifest) ([source](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Reference/Manifest.md))
- [Versions reference](https://docs.obsidian.md/Reference/Versions) ([source](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Reference/Versions.md))
- [Manage your plugin or theme](https://docs.obsidian.md/Community+directory/Manage+your+plugin+or+theme) ([source](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Community%20directory/Manage%20your%20plugin%20or%20theme.md))
- [Community directory FAQ](https://docs.obsidian.md/Community+directory/Frequently+asked+questions) ([source](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Community%20directory/Frequently%20asked%20questions.md))
- [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) ([source](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Plugin%20guidelines.md))
- [Official sample plugin release workflow](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/.github/workflows/release.yml)
- [Live Community Plugins registry](https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json)
- [`obsidian-releases` mirror workflow](https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/mirror-community-json.yml)

## Uncertainties to verify during submission

- Current documentation describes automated review operationally but still contains wording about “reviewed and published.” It does not specify a universal separate human-review SLA.
- The complete server-side scanner rule inventory is not public. The management UI's **Review branch** result is the authoritative pre-submission check.
- Obsidian's fork classification is policy-dependent; obtain an explicit answer/approval rather than assuming that substantial divergence removes the requirement.
- Candidate name and ID availability can change at any time.
