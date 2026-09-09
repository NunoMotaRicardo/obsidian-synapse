# Codebase design audit — module depth, interfaces, seams

> **Flag (2026-09-09):** this is a point-in-time snapshot at commit `e6acb71`. Issue #220 removed
> `vaultTools.ts` and `mcpBridge.ts` entirely and shrank `providerModels.ts` from 983 lines to a
> small local-agent-endpoint discovery module (see
> `.docs/decisions/2026-09-09-anthropic-only-provider-and-batch-loop-removal.md`), so the module
> table below (and any line-count/fan-in figures it cites) is stale for those modules. Treat this
> report as historical measurement, not a description of the current codebase shape. Issue #221
> subsequently deleted `batchLoopExecutor.ts`/`modals/batchLoopProgressModal.ts` with no
> replacement — the module table row for `batchLoopExecutor.ts` no longer describes an existing
> file.

**Date:** 2026-09-05
**Commit audited:** `e6acb71` (`main`, immediately after epic #144 closed)
**Method:** static measurement of every module in `src/` — lines, exported symbols, externally
referenced symbols, and import fan-in — read alongside `.docs/architecture.md` and the specs.
Vocabulary follows the `codebase-design` skill: **module** (interface + implementation),
**interface** (everything a caller must know), **depth** (behaviour per unit of interface),
**seam** (where an interface lives), **leverage** (what callers gain), **locality** (what
maintainers gain).

This is a design audit, not a bug hunt. Nothing here is a defect in behaviour.

---

## 1. Shape of the codebase

17,203 lines across 35 modules in `src/`, 5,542 lines of tests. The distribution is
top-heavy — four modules hold 31% of the code:

| Module | LOC | Exported | Used elsewhere | Unused | Fan-in |
|---|---|---|---|---|---|
| `agentService.ts` | 1782 | 24 | 17 | **7** | 14 |
| `synapseView.ts` | 1393 | — | — | — | — |
| `settings.ts` | 1183 | 11 | 7 | **4** | 3 |
| `editor/editorMenu.ts` | 1172 | 10 | 1 | — | 1 |
| `view/sessionSidebar.ts` | 1079 | — | — | — | — |
| `providerModels.ts` | 983 | 19 | 14 | **5** | 5 |
| `view/sessionConfig.ts` | 760 | 23 | **23** | 0 | 5 |
| `configWriter.ts` | 613 | 17 | 14 | 3 | 6 |
| `runExecutor.ts` | 534 | 12 | **4** | **8** | 2 |
| `triggers.ts` | 505 | 5 | 4 | 1 | 2 |
| `batchLoopExecutor.ts` | 485 | 12 | 10 | 2 | 2 |
| `vaultPaths.ts` | 81 | 6 | 5 | 1 | 10 |
| `toolErrors.ts` | 40 | 3 | **1** | 2 | 1 |

Repo-wide, **48 exported symbols have no reference outside their own file** — not in `src/`,
not in `test/`. Verified by spot-check, not just by grep heuristic.

---

## F1. The session-event seam has no compile-time interface — this is the deepest problem

```ts
export interface SessionEvent {
	type: string;
	data: Record<string, unknown>;
}
```

`type` is `string`. `Session.dispatch()` fans out only to handlers registered for that exact
string, and `registerSessionEvents()` in `synapseView.ts` is the only live delivery path. So an
event the service dispatches but the view never registers is silently dropped — no error, no
type failure, no failing test.

That is not hypothetical. It is exactly how #130's `session.metadata` shipped **dead**:
dispatched every turn, listened for nowhere, so the context gauge could never appear. The
feature was complete, tested, reviewed, and inert.

The interface here is doing none of the work an interface exists to do. A caller must know
which string literals are valid, which are live, and that registration is mandatory — and none
of that is expressible in the type. The current mitigation is `test/sessionEventWiring.test.ts`,
which reads both source files as **text** and asserts every dispatched literal appears in the
registration list. That test is well-reasoned and worth keeping, but needing a source-grep test
to enforce a contract is the clearest possible signal that the contract belongs in the type
system instead.

**Recommendation.** Replace `type: string` with a discriminated union, or better, a typed event
map (`type SessionEvents = {'session.metadata': MetadataPayload; 'session.idle': …}`) with
`dispatch<K extends keyof SessionEvents>` and `on<K extends keyof SessionEvents>`. This makes
`data` typed per event as a side benefit — today every handler re-validates
`Record<string, unknown>` by hand. 6 dispatched event types, 16 registrations: small enough to
convert in one pass.

This raises depth without widening the interface: callers learn *less* (the compiler tells them
what is valid), and the failure mode moves from silent-at-runtime to loud-at-compile.

---

## F2. Several modules publish their internals as their interface

`runExecutor.ts` is the sharpest case. It exports 12 symbols; **4** are referenced anywhere
else, and only `runItem()` is a real entry point. `applyWriteMode`, `substituteTemplates`,
`formatToolRefusalsReportBlock`, `ToolApprovalPolicy`, `ToolRefusal`, `WriteMode`,
`ApplyWriteModeOptions` and `RunItemOptions` have no reader outside the file.

The irony is that `runExecutor` is otherwise the **best deep module in the codebase** (see §5).
Its actual interface — one function — is excellent. The other 11 exports are implementation
details wearing the interface's clothes. They cost nothing at runtime and everything in "what
must a reader learn before touching this file".

Same pattern, smaller: `toolErrors.ts` exports 3, uses 1. `bots/telegramApi.ts` exports 9 wire
types nothing else names. `agentService.ts` exports `ConnectionState`, `AuthConfig`,
`VersionInfoCallback`, `TaskPlan`, `FALLBACK_CLAUDE_MODELS`, `DEFAULT_AGENTIC_MAX_TURNS`,
`BetaRawMessageStreamEvent` — none read elsewhere.

**Recommendation.** Drop `export` where there is no external reader. Where a symbol is exported
*only* so a test can reach it, see F3. This is mechanical, has no runtime effect, and shrinks
the interface of the four largest modules substantially. Worth doing as one sweep with the build
as the check — TypeScript will name anything genuinely needed.

---

## F3. `mapSdkModel` is exported only for tests — testing past the interface

`mapSdkModel` has exactly one consumer: `test/agentService.test.ts`. No production caller.

The skill's principle is that the interface *is* the test surface: if a test must reach past the
interface, the module is likely the wrong shape. Here the mapping logic is genuinely worth
testing, which suggests it wants to be its own small module with its own honest interface —
model-catalogue mapping is a distinct concern from session lifecycle — rather than a private
helper with a test-only door cut into `agentService`'s wall.

**Recommendation.** Either move model mapping into its own module (with `mapSdkModel` as part of
a real interface), or test it through `AgentService`'s public surface. Do not leave a test-only
export.

---

## F4. `agentService.ts` is three modules at one seam

1782 lines, 24 exports, fan-in 14 — the hub every other module depends on. Inside it, three
unrelated concerns share a seam:

- **SDK session lifecycle** — `AgentService`, `Session`, `inlineChat`, permission adapters.
  This is the module's real job, and it is deep.
- **Model catalogue mapping** — `mapSdkModel`, `ModelInfo`, `FALLBACK_CLAUDE_MODELS`.
- **View-facing payload parsers** — `parseTodoWritePayload`, `parseTaskCreateInput`,
  `parseTaskUpdateInput`, `parseTaskCreateResultId`. Every consumer of these four is a *view*
  module (`synapseView.ts`, `view/sessionSidebar.ts`). They normalise SDK tool payloads into the
  shape the task panel wants — a view concern living inside the SDK service.

Applying the **deletion test** to the parser group: delete them from `agentService` and the
complexity does not vanish, it moves to the two view modules that already own the task panel —
which is where the knowledge belongs. That is a seam in the wrong place, not a missing module.

**Recommendation.** Extract the four parsers to `src/view/taskPayloads.ts` (or into the sidebar,
if the view is their only home). This removes four symbols from the interface of the most
depended-on module in the codebase, and puts them next to the code that defines what a task
panel row is. CLAUDE.md's rule that *all SDK access goes through `agentService`* is not violated:
these parsers touch payload shapes, not the SDK.

Do **not** split `AgentService`/`Session` themselves. That part is deep and the single-service
rule is load-bearing.

---

## F5. The barrels are half-adopted, so they are not a seam

`modals/index.ts` exports 8 symbols; `bots/index.ts` exports 3. Three files import through a
barrel; **six** files import modal modules directly by path. Of the 11 barrel exports, 3 are
actually consumed through the barrel.

A barrel is a seam only if it is *the* way in. A half-used barrel is a second name for every
module — the worst of both, since a reader must now check two import styles to find all callers.

**Recommendation.** Pick one. Either route all modal/bot imports through the barrel and treat it
as the package interface, or delete both barrels and import directly. Deleting is the smaller
change and matches how most of the codebase already behaves.

---

## §5. What is already right — hold these up as the pattern

Three modules are worth citing as the standard the rest should move toward.

**`runExecutor.ts`'s actual interface (#154).** One entry point, `runItem()`, behind which sits
the entire unattended-run pipeline — template substitution, model routing, write modes, report
appending, tool-approval policy. The proof of its depth is unusually strong: when #154 extracted
it, `git diff test/` was **empty** — the #152 executor tests, written against the *old* call
sites, passed unchanged. Behaviour was preserved across a large move because the interface was
the right one. Fix F2's export bloat and this is exemplary.

**`vaultPaths.ts`.** 81 lines, 5 used exports, fan-in 10 — one of the smallest modules and the
third most depended-upon. The deletion test is decisive: remove it and the
`(app.vault.adapter as unknown as {basePath: string}).basePath` cast reappears in seven files,
`todayString()` and `REPORTS_FOLDER` go back to being defined twice, and the local-plugin config
object is rebuilt in seven places. Small implementation, large locality. It also has **zero
internal imports**, so nothing can cycle back into it — a deliberate choice recorded in its spec.

**`view/sessionConfig.ts`.** 23 exports and **all 23 are used**. A wide interface is not
automatically a bad one; this module is a genuine collection of independent helpers, and nothing
is published speculatively.

---

## Recommended order

Sequenced by leverage per unit of risk.

1. **F2 — drop unused exports.** Mechanical, zero runtime effect, compiler-verified. Shrinks the
   interfaces of the four biggest modules in one pass. Start here.
2. **F5 — resolve the barrels.** Small, purely structural, removes an ambiguity every new reader
   currently has to resolve.
3. **F1 — type the session-event seam.** The highest-value change in this report, and the only
   one that removes a whole class of shipped-dead-feature bug. Medium risk, so do it on its own
   with the existing wiring test kept as a belt-and-braces check until the types land.
4. **F4 — move the task-payload parsers to the view.** Depends on nothing above; independent.
5. **F3 — give model mapping an honest home.** Naturally follows F4, since both carve a distinct
   concern out of `agentService`.

None of these is urgent. F1 is the one with a demonstrated cost already paid — twice, if you
count #163's follow-on defects — and is the one worth scheduling deliberately rather than
waiting for a third occurrence.

---

## Caveats

- Fan-in and usage counts come from identifier-level source matching. They are reliable for the
  distinctive names used here, and the unused-export findings were spot-checked individually, but
  a symbol referenced only through a dynamic string would not be caught.
- `synapseView.ts` (1393 lines) and `view/sessionSidebar.ts` (1079) were measured but not
  analysed in depth here. Both are Obsidian `ItemView` subclasses whose interface is the
  framework's, not one this codebase chose, so the module-depth lens applies differently. They
  are the obvious subject of a follow-up.
- No behavioural claim in this report was taken on faith from the specs; each was checked against
  `src/` at `e6acb71`.
