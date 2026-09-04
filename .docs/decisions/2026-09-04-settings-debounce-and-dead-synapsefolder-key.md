# Settings: Debounce Provider Fields, Remove Dead `synapseFolder` Key (issue #148)

Status: **decided and implemented** (2026-09-04)

## Context

Two independent defects in `src/settings.ts`, filed together as one issue because they're one
file and one PR (part of #144):

1. The provider **Base URL** and **API key** text fields' `onChange` handlers called
   `await this.plugin.initAgentService()` on every keystroke.  `initAgentService()`
   (`src/main.ts`) stops the existing `AgentService`, constructs a new one, and — when
   `providerBaseUrl` is set — fires `fetchProviderModels()` for model discovery. Typing
   `http://localhost:11434` (22 characters) meant 22 teardown/rebuild cycles and 22
   discovery-request bursts for one intended change.
2. `synapseFolder: string` was declared on `SynapseSettings`, defaulted to `SYNAPSE_FOLDER` in
   `DEFAULT_SETTINGS`, and never read anywhere else in `src/`. Every actual call site (folder
   initialization, agent/skill/trigger scanning, etc.) uses the `SYNAPSE_FOLDER` constant
   (`src/vaultPaths.ts`) directly, not `settings.synapseFolder`.

## What was verified before making changes

- `grep -rn synapseFolder src/` (before this change) turned up exactly three hits: the
  interface declaration (`settings.ts:40`), the `DEFAULT_SETTINGS` entry (`settings.ts:146`),
  and `configWriter.ts`'s `ensureImproveSynapseSkill(app, synapseFolder = SYNAPSE_FOLDER)` — a
  same-named but unrelated *function parameter*, not a read of `settings.synapseFolder`, and
  out of scope for this issue (owned by #150/#154's concurrent work areas, untouched here).
  No other file reads `settings.synapseFolder`. Confirmed by direct grep, not inferred from a
  comment.
- `SynapsePlugin.loadSettings()` (`src/main.ts`) merges persisted `data.json` over
  `DEFAULT_SETTINGS` via `Object.assign({}, DEFAULT_SETTINGS, raw)` — the same merge shape
  issue #106 already established tolerates stale keys (`contextTier`, `reasoningSummary`)
  without error, since `Object.assign` just copies `raw`'s own enumerable properties onto the
  result regardless of whether the target (`DEFAULT_SETTINGS`) has a matching key.

## Decision

**Debounce.** `SynapseSettingTab` gained one `private readonly` instance field:

```ts
private readonly debouncedInitAgentService = debounce(() => {
	void this.plugin.initAgentService();
}, 500, true);
```

built with Obsidian's own `debounce()` (not a hand-rolled timer, per the issue's technical
notes). `resetTimer: true` means the 500ms window restarts on every call — a trailing-edge
debounce that fires once, 500ms after the *last* keystroke. Both the Base URL and API key
`onChange` handlers now call `this.debouncedInitAgentService()` instead of directly awaiting
`initAgentService()`. Everything else in those handlers — `settings.providerBaseUrl = val.trim()`
+ `saveSettings()` for Base URL, `updateSecureField()` (in-memory + `localStorage`, `data.json`
never touched) for API key — stays synchronous and un-debounced, so the persisted/secure value
is always correct on the very first and very last keystroke of a burst, even if the settings tab
is closed mid-burst.

`SynapseSettingTab.hide()` is now overridden to call `this.debouncedInitAgentService.cancel()`.
Obsidian calls `hide()` "when the user navigates away, the containing tab is switched, or the
settings modal is closed" (`obsidian.d.ts`'s `SettingTab#hide()` doc comment) — without the
cancel, a pending debounced call scheduled just before the tab closes would still fire ~500ms
later against a settings tab the user believes is gone, rebuilding `AgentService` on stale
`this.plugin` state. This is exactly the leak class the repo's `register*`-helper convention
exists to prevent; `debounce().cancel()` is the equivalent cleanup hook for a debouncer that
isn't itself a `register*`-managed timer/listener.

**Scope.** Deliberately limited to Base URL + API key, matching the issue's acceptance criteria.
The **Bearer token** field (`ollama`-only) and the **Claude CLI location** field have the
identical per-keystroke `initAgentService()` pattern and are equally affected, but extending the
fix to them was not requested and is left as a follow-up rather than bundled in silently.

**Dead `synapseFolder` key removal.** `synapseFolder` is removed from both the
`SynapseSettings` interface and `DEFAULT_SETTINGS`. This is a **genuine no-op migration**: the
value was never read by any code path, so there is nothing to migrate *to* — a fresh install and
an upgraded install behave identically after this change, because they behaved identically
*before* it too (the setting was always inert). No migration function, no `Notice`, no special
`loadSettings()` handling was added, unlike the #117 `providerPreset` alias migration (which
*does* change which value a stale key resolves to and needs one-time handling). This mirrors
the #106 precedent (`reasoningSummary`/`contextTier` removal) exactly, and is now documented in
`.docs/specs/settings.md`'s Invariants section alongside it.

A stale `synapseFolder` value left in an existing `data.json` from a pre-#148 plugin version
rides along as a harmless untyped property after the `Object.assign({}, DEFAULT_SETTINGS, raw)`
merge — never read, never causes a load error, produces no console noise. Proven by extending
`test/settings.test.ts`'s existing `legacy settings key tolerance` describe block (which already
covered `contextTier`/`reasoningSummary` for #106) to include a stale `synapseFolder` in its
`legacyRaw` fixture, asserting: the merge doesn't throw, `synapseFolder` is absent from
`DEFAULT_SETTINGS`'s own keys, and a stale `synapseFolder` value survives the merge unchanged as
an extra property rather than being stripped or erroring.

## Verification

- `npm run build` (`tsc -noEmit -skipLibCheck` + esbuild production bundle): clean.
- `npm run lint`: 0 errors, 2 warnings — both pre-existing and unrelated (an `eslint.config.mts`
  `@typescript-eslint/no-deprecated` warning, and `settings.ts`'s existing
  `obsidianmd/settings-tab/prefer-setting-definitions` warning, unchanged by this change).
- `npm run test`: 351 passed across 20 test files — the pre-existing 348/19 baseline plus one
  new file, `test/settingsDebounce.test.ts` (3 new tests).
- Debounce behaviour was proven (not just implemented) by driving the real
  `SynapseSettingTab.debouncedInitAgentService` field — reached into via the same
  `as unknown as {...}` private-field pattern `test/mcpBridge.test.ts` already uses for
  `_drainLines` — under `vi.useFakeTimers()`, against a `debounce()` mock added to
  `test/setup.ts`'s `vi.mock('obsidian', ...)` factory. That mock is a from-scratch
  reimplementation of the `resetTimer` contract described in `obsidian.d.ts`'s doc comment
  (Obsidian's real implementation lives in its closed-source `app.js`, not in
  `node_modules/obsidian`, which ships type declarations only), because the existing mock had
  no `debounce` export at all before this change (nothing in the test suite previously exercised
  it). Observed:
  - A 22-call burst spaced 50ms apart (simulating typing `http://localhost:11434`) produces
    **zero** `initAgentService()` calls until 500ms after the *last* call, then exactly **one**.
  - A single call still fires once after 500ms (no starvation on a one-character edit).
  - Calling `hide()` after a pending call cancels it — advancing fake timers by 10 seconds
    afterward still produces zero `initAgentService()` calls.
- Deploy-testing in the real vault was explicitly out of scope for this change (per the
  orchestrating instructions for this session) — not performed.

## Consequences

- Typing a full Base URL or API key now costs one `AgentService` rebuild + one discovery
  request, not one per character, matching the acceptance criteria.
- `settings.synapseFolder` no longer exists as a typed field; any code that referenced it would
  now fail to compile (none did — confirmed above).
- The Bearer token and Claude CLI location fields retain the pre-#148 per-keystroke
  `initAgentService()` behaviour; a future issue can extend the same
  `debouncedInitAgentService()` call to them if desired.
