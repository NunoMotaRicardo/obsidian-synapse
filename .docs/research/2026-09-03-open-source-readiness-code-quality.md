# Open-source readiness — code quality report

> Date: 2026-09-03 · Scope: full sweep of `src/` (15,528 LOC, 38 files), `test/`, build config,
> CI, repo metadata and docs, against the goal of publishing `obsidian-synapse` publicly.
> Verification run for this report: `tsc -noEmit` clean, `vitest run` 108/108 passing,
> `eslint .` 0 errors / 2 warnings.

---

## 0. Executive summary

**The codebase is in good shape.** This is not a rescue job. Typecheck is clean under `strict`,
lint is essentially clean, there is zero `any`, zero `innerHTML`, no silent empty catches, no
hardcoded colours in 42KB of CSS (319 `var(--…)` uses, 0 literals), and JSDoc density is unusually
high — several modules explain *why* rather than *what*, which is exactly what an external
contributor needs.

What is missing is not code quality but **quality of the project as a public artifact**, plus a
handful of genuine defects and one structural duplication that will get embarrassing as soon as a
fourth automation surface is added.

Ranked by what I would fix before flipping the repo public:

| # | Item | Severity | Effort |
|---|---|---|---|
| 1 | No `CONTRIBUTING.md` / `SECURITY.md` / issue templates / PR template | **Blocker for OSS** | S |
| 2 | CI never runs the test suite | **High** | XS |
| 3 | Dead *and* wrong code: `buildEnv(forLocalModel)` sets `ANTHROPIC_BASE_URL` to an OpenAI-shaped URL | **High** | XS |
| 4 | `providerBearerToken` is a fully-wired setting with no UI | **High** | S |
| 5 | Settings text fields tear down the agent service on every keystroke | **High** | S |
| 6 | Three parallel "run a prompt, write a report" executors duplicating each other | **High** | L |
| 7 | Claude-backed triggers run `permissionMode: 'default'` with **no** `canUseTool` | **High** | M |
| 8 | Ollama model discovery is 1 + N serial HTTP round-trips | Medium | S |
| 9 | `settings.synapseFolder` is dead; `_synapse` literal hardcoded in 8 places | Medium | S |
| 10 | `settings.display()` is a single 590-line method | Medium | M |
| 11 | Tests cover 6 of 38 modules; no coverage tooling at all | Medium | L |
| 12 | README's provider table does not match the shipped dropdown | Medium | XS |
| 13 | Personal absolute paths baked into `.claude/skills/deploy-test` and `CLAUDE.md` | Low (but public) | XS |
| 14 | Stale repo names/links across `.docs/` (`obsidian-copilot`, `obsidian-claude-brain`) | Low | S |

---

## 1. What is already good (don't regress it)

Worth stating explicitly, because an audit that only lists problems misleads:

- **Type safety.** `tsc --strict` passes. The only two `: any` grep hits are the word "any" inside
  prose comments. Every unavoidable cast is `as unknown as {…}` with a narrow shape, never `as any`.
- **No DOM injection.** Zero `innerHTML` / `outerHTML` / `insertAdjacentHTML`. Everything goes
  through Obsidian's `createEl`/`createDiv`. This is the most common Obsidian plugin-review
  rejection and you are clean on it.
- **Theming.** `styles.css` uses 319 CSS custom properties and **zero** hardcoded colour literals,
  with only 6 `!important`. This passes community review as-is.
- **Lifecycle hygiene.** Listeners via `registerEvent()`, intervals via `registerInterval()`, and
  the modules holding their own timers (`TriggerWatcher`, `SynapseView`) clear them in
  `stop()`/`onClose()`.
- **Concurrency.** `lockManager.ts` is a real advisory per-path lock, and every plugin-initiated
  vault write goes through it with a documented graceful-degradation path on
  `LockAcquisitionError`. That is more care than most plugins take.
- **Process hygiene.** `mcpBridge.ts` spawns with `shell: false` and kills the *process tree* via
  `taskkill /t` on win32, because `npx` is really `cmd.exe`. Someone found that bug and fixed it
  properly.
- **Secrets.** API keys/tokens live in vault-scoped `localStorage` (`SECURE_FIELDS`), never in
  `data.json` (which is gitignored anyway). `main.js` is untracked. 131 tracked files, no stray
  artifacts.
- **Docs-as-code.** `.docs/specs/` + `.docs/decisions/` + `wiki/`, with `CLAUDE.md` enforcing
  "update the spec in the same change." Keep this — it is a selling point for contributors.

---

## 2. Blockers for going public

### 2.1 Missing community health files

The repo has `LICENSE.md` (MIT) and a good `README.md`, and nothing else GitHub looks for:

```
MISSING  CONTRIBUTING.md
MISSING  SECURITY.md
MISSING  CODE_OF_CONDUCT.md
MISSING  .github/ISSUE_TEMPLATE/   (bug_report.yml, feature_request.yml)
MISSING  .github/PULL_REQUEST_TEMPLATE.md
```

`SECURITY.md` matters more than usual here — see §2.2. `CONTRIBUTING.md` should state: Node
version, `npm run build` / `lint` / `test`, that `.docs/specs/<module>.md` must be updated in the
same PR, the tabs-and-single-quotes convention, and that `main.js` is never committed.

### 2.2 The security surface needs an honest, prominent write-up

Nothing here is *wrong*, but a public repo needs these stated up front rather than discovered:

- **`src/bots/telegramBot.ts:324-325`** runs every Telegram-sourced message with
  `permissionMode: 'bypassPermissions'` **and** `allowDangerouslySkipPermissions: true`, with `cwd`
  at the vault root. The mitigations are real and correct — a non-empty numeric allowlist is
  *required* before connecting (`telegramBot.ts:84-88`) and re-checked per message
  (`telegramBot.ts:171-177`). But the practical statement is: *anyone on that allowlist has
  unattended, unapproved, full read/write agent access to the vault from their phone.* That belongs
  in `SECURITY.md` and as a warning in the Telegram settings tab, not only in a spec.
- **`src/mcpBridge.ts:172`** spawns arbitrary commands declared in a vault-local `_synapse/.mcp.json`.
  That is the intended MCP model, done safely (`shell: false`), but a vault synced from an untrusted
  source becomes arbitrary code execution. Document it.
- **`toolApproval: 'allow'`** flips editor actions, the edit modal and search to `bypassPermissions`
  (`editorMenu.ts:510`, `editModal.ts:464`, `searchPanel.ts:273-274`). The settings copy should say
  plainly what that means.

Recommendation: one `SECURITY.md` with a "Threat model" section covering these three, plus a
disclosure address. This turns a liability into evidence of care.

### 2.3 CI does not run the tests

`.github/workflows/lint.yml` runs `npm ci`, `npm run build`, `npm run lint` on Node 22.x and 26.x.
It never runs `npm run test`. 108 passing tests are therefore decorative — nothing stops a PR from
breaking them.

```yaml
- run: npm run test
```

One line. Do it before the repo is public, and rename the workflow from "Node.js build" to "CI"
while you are in there.

---

## 3. Defects

### 3.1 Dead code that is also wrong — `buildEnv(forLocalModel)`

`src/agentService.ts:372-397` accepts `forLocalModel = false` and, when true, sets:

```ts
env['ANTHROPIC_BASE_URL'] = baseUrl;   // baseUrl ends in /v1 for ollama
env['OPENAI_BASE_URL']    = baseUrl;
```

**All four call sites pass no argument** (`agentService.ts:504, 704, 790, 862`), so the branch never
runs. Fortunate, because it would not work: `ANTHROPIC_BASE_URL` redirects the Claude CLI at an
endpoint that must speak the **Anthropic Messages API** (`/v1/messages`), and Ollama's `/v1` is
OpenAI-shaped. Pointing Claude Code at `http://localhost:11434/v1` fails — which is exactly why the
ecosystem puts a translating proxy (LiteLLM and friends) in between.

**Action:** delete the branch and the parameter. Then, if you want the capability, implement it
deliberately — see the automation report, §"One engine, two backends", where this is the linchpin
of the whole redesign.

### 3.2 `providerBearerToken` — a setting with no way to set it

`providerBearerToken` is declared (`settings.ts:38`), defaulted (`:144`), listed in `SECURE_FIELDS`
(`:175`), passed into `AgentService` from `main.ts`, and consulted **first** in every auth path
(`providerModels.ts:47, 269`). There is **no `new Setting(...)` for it anywhere.** It is
permanently `''`.

Worse, the API-key field it would complement is hidden for Ollama entirely:

```ts
// settings.ts:581
if (this.plugin.settings.providerPreset !== 'ollama') { /* render API key */ }
```

So a remote or reverse-proxied Ollama behind any auth cannot be configured through the UI at all.
The `2026-06-26-ollama-cloud-models-support.md` decision explains why *Ollama Cloud* needs no key
(the local daemon brokers it) — sound reasoning that does not extend to "user runs Ollama on a home
server behind a token."

**Action:** either surface the bearer-token field (and stop hiding auth for Ollama), or delete the
setting and its plumbing. A half-wired credential field in a public repo invites bug reports.

### 3.3 Settings text inputs restart the whole service per keystroke

`settings.ts:566-579` (Base URL) and `:586-596` (API key):

```ts
.onChange(async (val) => {
    this.plugin.settings.providerBaseUrl = val.trim();
    await this.plugin.saveSettings();
    await this.plugin.initAgentService();   // ← every keystroke
}));
```

`initAgentService()` (`main.ts:208-246`) stops the existing `AgentService`, constructs a new one,
**and fires `fetchProviderModels()`**. Typing `http://localhost:11434` is 22 keystrokes → 22 service
teardowns and 22 model-discovery storms, each of which for Ollama is itself 1 + N HTTP calls (§3.5).
There is no `debounce` anywhere in `settings.ts`.

**Action:** wrap both handlers in Obsidian's `debounce(fn, 500, true)`.

### 3.4 Claude-backed triggers cannot use write tools

`triggerExecutor.ts:205-230` calls `inlineChat` with `permissionMode: 'default'` and **no**
`canUseTool` callback. In the SDK, `default` means "ask" — with no callback and no UI, any tool
requiring approval is refused. Read-only tools generally pass; `Write`/`Edit` do not.

The trigger system papers over this by taking the model's *text* response and writing it itself
(`applyWriteMode`), so the common cases work. But a trigger whose prompt says "also update the index
note" will silently do nothing, and nothing surfaces the refusal. `batchLoopExecutor.ts:255` has the
same shape, while the Telegram bot deliberately went the other way (`bypassPermissions`). Three
unattended surfaces, three different policies.

**Action:** pick one policy for unattended execution and apply it in all three. Recommendation:
honour `settings.toolApproval` (`allow` → `bypassPermissions`; `ask` → a `canUseTool` that
denies-and-logs *into the report*, so the refusal is visible), with per-trigger frontmatter opt-in.

### 3.5 Ollama model discovery is 1 + N serial round-trips

`providerModels.ts:71-152`: fetch `/api/tags`, then for **each** model `await` a `POST /api/show` to
read capabilities — sequentially, inside the loop. Twenty installed models = twenty-one sequential
HTTP calls. `ollamaShowCache` helps on repeat, but the Test button clears it (`settings.ts:526`),
and it is keyed by model id only — so switching Ollama hosts serves stale capabilities from the old
host.

**Action:** `Promise.all` the `/api/show` calls with a small concurrency bound (8), and key the cache
on `baseUrl + '\0' + id`.

### 3.6 Smaller correctness notes

- **`triggerExecutor.ts:29-35`** — `{{files}}` substitutes the *same single* path as `{{file}}`,
  including for scheduled triggers, where the scheduler already fans out one execution per file
  (`triggers.ts:465-476`). The variable is documented in the spec and in the seeded skill text
  (`configWriter.ts`) as if it were a list. Implement it or remove it from the docs.
- **`agentService.ts:532-539`** — `isLocalModel()` returns true for any id present in
  `customModels`. Since `customModels` is whatever `/v1/models` returned, selecting the
  **Anthropic (BYOK)** preset and pressing Test loads `claude-*` ids into `customModels`, after
  which every `claude-*` model routes down the degraded local one-shot path instead of the Agent
  SDK. The `!/^claude-/i` guard on line 536 never runs, because the `customModels` check on line 534
  returns first. Detail in the provider report.
- **`inlineChat`'s local-model branch (`agentService.ts:752-771`)** passes no `tools`/`app`, so
  editor actions and search on a local model get a bare one-shot with no vault tools — while
  `triggerExecutor.executeWithLocalModel` gives the same models the full ReAct + MCP kit. One
  concept, two very different capabilities, no user-visible explanation.

---

## 4. Structural duplication — the one real refactor

Three modules now independently implement the same pipeline:

| | `triggerExecutor.ts` | `batchLoopExecutor.ts` | `synapseView.ts` |
|---|---|---|---|
| Route Claude vs local | `:340-352` | via `inlineChat` | `:1160-1200` |
| Build `_synapse` plugin path | `:212-214` | `:244-246` | `:1197` |
| `basePath` cast | `:170, 212` | `:244` | `:1231` |
| `todayString()` | `:42-49` | `:141-148` | — |
| `REPORTS_FOLDER` const | `:54` | `:41` | — |
| Ensure reports folder | own `ensureReportsFolder` `:59` | shared `ensureFolder` | — |
| Lock + append report | `:88-125` | `:176-198` | — |
| Budget / turn caps | none | `budget.ts` | `budget.ts` |

Concretely repeated across the codebase:

- `(app.vault.adapter as unknown as {basePath: string}).basePath` — **21 occurrences**.
- `plugins: [{type: 'local', path: '…/_synapse/'}]` — **8 occurrences**, six rebuilding the path
  string inline (`telegramBot.ts:327`, `editorMenu.ts:697`, `editModal.ts:462`,
  `synapseView.ts:1197`, `searchPanel.ts:264`, plus the two executors).
- The literal `'_synapse'` appears in **8 non-comment places** despite
  `export const SYNAPSE_FOLDER = '_synapse'` at `settings.ts:8`.
- `todayString()` copy-pasted verbatim into two files.
- `REPORTS_FOLDER` defined twice with the same value.

`budget.ts` proves you already know the fix — it was extracted precisely so the batch loop and chat
view stopped duplicating parse/describe/exceeded. Do the same one level up.

**Proposed:** a `src/vaultPaths.ts` (`getVaultBasePath(app)`, `getSynapsePluginConfig(app)`,
`SYNAPSE_FOLDER`, `REPORTS_FOLDER`, `todayString()`), plus a `src/runExecutor.ts` owning
*substitute → route model → run → apply write mode → append report → stamp*. `triggerExecutor` and
`batchLoopExecutor` become thin callers differing only in what produces the work items. This is
also the precondition for the automation redesign — **do not build a fourth executor on top of the
current three.**

---

## 5. Maintainability

### 5.1 Oversized units

| File | LOC | Note |
|---|---|---|
| `src/agentService.ts` | 1458 | Justified — it is the SDK boundary and CLAUDE.md mandates that. Still, `Session` (from ~`:1080`) could be its own file. |
| `src/synapseView.ts` | 1267 | 80 methods on one class; `handleSend()` alone is ~186 lines (`:497-683`). |
| `src/editor/editorMenu.ts` | 1172 | Menu registration + image resolution + mermaid extraction + prompt building in one module. |
| `src/settings.ts` | 1125 | **`display()` is a single 590-line method** (`:302-892`) with nested closures (`renderAuthFields`, `renderProviderFields`, `updateProviderDesc`, `updateModelDatalist`). |

`settings.ts` is the worst and the easiest to fix: tab ids already exist (`:312` — `claude, agents,
capabilities, tools, bots, triggers`) and two tabs are *already* extracted into `renderBotsPanel` /
`renderTriggersPanel`. Extract the other four the same way and `display()` drops to ~60 lines. Low
risk, high readability payoff for a first-time contributor.

### 5.2 Dead / vestigial

- **`settings.synapseFolder`** (`:39`, `:145`) — declared, defaulted, **never read**. The folder is
  hardcoded via `SYNAPSE_FOLDER` everywhere. Delete it (it lives in users' `data.json`, so note the
  no-op migration) or actually honour it.
- **`buildEnv`'s `forLocalModel` branch** — §3.1.
- **`providerBearerToken`** — §3.2.
- `.github/copilot-instructions.md` and `.github/instructions.md` are pre-fork leftovers referencing
  the old workflow. `AGENTS.md` and `GEMINI.md` supersede them.

### 5.3 Naming still carrying the fork's history

The rename to Synapse is ~95% done. Remaining public-facing residue:

- `.docs/decisions/2026-06-14-github-issue-workflow.md` names the tracker as
  `NunoMotaRicardo/obsidian-copilot` (three times).
- `.docs/audits/code-audit-2026-06-30.md`, `.docs/decisions/2026-06-29-native-sdk-customization-model.md`
  and `.docs/research/competitor-landscape.md` link to `obsidian-claude-brain`.
- `.docs/testing/ollama-test-instructions.md` links an issue on `obsidian-copilot`.
- The local checkout directory is still `obsidian-claude-brain`.

Historical decision records legitimately preserve the name true at the time — but the *links* 404.
Fix the URLs, keep the prose. Separately, `.docs/specs/config-writer.md` exists while
`architecture.md` links it twice as `config-loader.md` (dead link).

### 5.4 Personal data in a soon-to-be-public repo

- `.claude/skills/deploy-test/SKILL.md:11,20` and `CLAUDE.md:35` hardcode
  `D:\nmr-obsidian\obsidian-configs\.obsidian\plugins\synapse\` — a real vault path on a real
  machine, with the username in the tree. Parameterise it (`$SYNAPSE_TEST_VAULT`, documented
  default), or move the skill to a gitignored `.claude/skills.local/`.
- `LICENSE.md` and `manifest.json` carrying your name is fine and intended.

---

## 6. Testing

108 tests, 8 files, ~1120 lines, all green in 416ms. Good tests where they exist —
`lockManager.test.ts` (246 lines) is genuinely thorough. But:

**Tested (6/38 modules):** `agentService`, `budget`, `lockManager`, `runtimeManager`, `settings`,
`triggers`, `view/sessionConfig`, plus one behaviour test (`workingDirAutoUpdate`).

**Untested and load-bearing:**

| Module | Why it matters |
|---|---|
| `providerModels.ts` (479) | Every URL, header and body-shape decision for every provider. All the provider defects in the third report would have been caught by one table-driven test asserting the constructed request per preset. **Highest-value target in the repo.** |
| `configWriter.ts` (601) | Frontmatter parse/serialize plus all vault writes. `parseFrontmatter` round-tripping is textbook unit-test material, and `triggerExecutor`'s frontmatter write mode depends on it. |
| `triggerExecutor.ts` (374) | Write modes, empty-response guard, lock fallbacks — all pure-ish logic behind thin `App` seams. |
| `batchLoopExecutor.ts` (577) | Scope resolution, budget enforcement, cancellation. |
| `mcpBridge.ts` (351) | JSON-RPC framing and line buffering. `_drainLines` is a classic off-by-one home. |

There is also **no coverage tooling** — `vitest.config.ts` has no `coverage` block and
`@vitest/coverage-v8` is not a dependency. Add it, publish the number in the README, and gate PRs on
"does not decrease."

`test/setup.ts` mocks the Obsidian API in 99 lines. That mock is the bottleneck for testing anything
UI-adjacent; expanding it is the unlock for `configWriter` and both executors.

---

## 7. Documentation accuracy

- **`README.md:155-160`** — the provider table claims Foundry Local and "Other OpenAI-compatible"
  both use preset `openai`, and that Ollama's endpoint is `http://localhost:11434/v1`. The shipped
  dropdown (`settings.ts:501-509`) offers `ollama, openai, azure, anthropic, foundry-local,
  other-openai`, and the Ollama default is `http://localhost:11434` (no `/v1`). Two presets
  (`azure`, `anthropic`) are undocumented; two documented rows name a preset the UI doesn't select.
  See the provider report — the right fix is probably to shrink the dropdown to match the README,
  not the reverse.
- **`README.md:323`** — settings table says the Provider default is "Anthropic"; the code default is
  `'ollama'` (`settings.ts:141`).
- **`.docs/specs/bots-triggers.md`** still says "Actual execution is wired in a later issue (#51)"
  and describes matching as ending in `console.log('[synapse] Trigger … fired')` — both stale;
  execution *is* wired and the code calls `executeTrigger` (`triggers.ts:388`). The "Current status"
  section further down contradicts the earlier section, in the same document.
- **`architecture.md`** links `config-loader.md` twice; the file is `config-writer.md`.

---

## 8. Recommended sequence

**Before the repo goes public (~1 day):**

1. Add `CONTRIBUTING.md`, `SECURITY.md` (with the §2.2 threat model), `CODE_OF_CONDUCT.md`, issue
   and PR templates.
2. Add `npm run test` to CI; add `@vitest/coverage-v8` and a coverage job.
3. Delete `buildEnv`'s `forLocalModel` branch, `settings.synapseFolder`, and the two
   `.github/*instructions.md` leftovers.
4. Parameterise the vault path out of `deploy-test/SKILL.md` and `CLAUDE.md`.
5. Fix stale repo URLs in `.docs/`, the `config-loader.md` links, and the README provider table.
6. Debounce the two provider settings inputs.
7. Resolve `providerBearerToken`: surface it or remove it.

**First month of public life (~3–5 days):**

8. Extract `vaultPaths.ts`; replace the 21 `basePath` casts, 8 plugin-path builds, duplicate
   `todayString`/`REPORTS_FOLDER`, and the 8 `'_synapse'` literals.
9. Split `settings.display()` into per-tab render methods.
10. Add `providerModels.test.ts` — table-driven, asserting URL + headers + body shape per preset.
    Then `configWriter.test.ts`.
11. Decide and unify the unattended-execution permission policy (§3.4).
12. Parallelise and re-key Ollama capability discovery.

**Before adding any new automation surface:**

13. Do the `runExecutor.ts` extraction (§4). Prerequisite, not optional cleanup.

---

## Related

- [`2026-09-03-automation-model-beyond-triggers.md`](2026-09-03-automation-model-beyond-triggers.md)
- [`2026-09-03-provider-matrix.md`](2026-09-03-provider-matrix.md)
- [`../audits/code-audit-2026-06-30.md`](../audits/code-audit-2026-06-30.md) — prior audit; most of
  its findings have since landed.
