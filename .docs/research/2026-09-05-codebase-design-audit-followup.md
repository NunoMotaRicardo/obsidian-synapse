# Design audit, second pass — closing the caveats

**Date:** 2026-09-05
**Commit audited:** `e6acb71` (`main`)
**Predecessor:** `2026-09-05-codebase-design-audit.md`

The first pass ended with three caveats. This pass closes two of them and, in doing so, turns
up material the first pass missed — including one shipped-dead feature of exactly the #130
kind, still dead today.

---

## Caveat 1 — "a symbol referenced only through a dynamic string would not be caught"

Closed. Every free-string namespace in `src/` was enumerated and checked.

| Namespace | Mechanism | Compiler-checked? | Result |
|---|---|---|---|
| Settings keys (`SECURE_FIELDS`) | `ReadonlyArray<keyof SynapseSettings>` | **yes** | safe — `keyof`-anchored |
| localStorage keys | `SECURE_PREFIX + key`, key from above | **yes** | safe |
| View type | `SYNAPSE_VIEW_TYPE` const, 14 uses | **yes** | safe |
| Command ids | declared once in `main.ts`, never re-matched | n/a | safe |
| Frontmatter keys | `meta['x']` read / `['x', …]` write | no | read set == write set, exactly 12 keys |
| **Session event types** | bare string, cross-module | **no** | **three defects — below** |

The dynamic-reference risk is real in exactly one place, and it is the one F1 already named.
The first pass's counts stand: no unused-export finding was an artifact of a dynamic
reference. Frontmatter is the only other unchecked namespace, and its two sides match
symbol-for-symbol (`agent description enabled event model name path schedule skills
toolApproval tools write`).

### F1 is worse than the first pass reported — in the opposite direction

The first pass, and `test/sessionEventWiring.test.ts` itself, checks one direction: *every
dispatched event has a handler*. Nothing checks the reverse. Three event types have handlers —
with real bodies, in both view modules — and **are never dispatched anywhere in `src/`**:

| Event | Handler does | Consequence |
|---|---|---|
| `skill.invoked` | `turnSkillsUsed.push(...)` → `renderMessageMetadata`'s skills chip | **the "skills used" chip in the message footer can never render** |
| `session.compaction_start` | `addCompactionStartBlock(data)` — pre-compaction token breakdown | the user sees compaction's "after" block, never its "before" |
| `assistant.reasoning` | `syncReasoningContent` + `finalizeReasoning` | benign — `assistant.message` finalizes reasoning too |

`skill.invoked` is the same class of defect as #130: a complete, reviewed, plumbed-through
feature that no event can ever reach. It runs from `agentService` → `synapseView.ts:1082` →
`view/types.ts` → `sessionSidebar.ts:759` → `chatRenderer.ts:569` — five files of live code,
and the producer was never written.

### The guard test reads only one of the two registration sites

`registeredEventTypes()` reads `src/synapseView.ts` alone. But `sessionSidebar.ts`'s
`registerBackgroundEvents()` is a **second** registration list, covering 11 of the 16 types.
The 5 it omits are `session.init`, `assistant.run_result`, `session.compaction_start`,
`session.compaction_complete`, `session.metadata`.

That omission looks deliberate — `restoreFromBackground()` calls `updateContextIndicator()`
explicitly, with a comment naming #130, to compensate for not tracking `session.metadata`
while backgrounded. The point is not that the sidebar is wrong; it is that **the test could
not tell either way**. A third registration site added tomorrow gets no coverage at all.

**Recommendation.** The typed event map from F1 fixes both directions at once: it makes an
undispatched-but-handled type a dead branch the compiler can see, and makes every registration
site checked rather than only the one the test happens to read. Until then, extend the wiring
test to read both files and assert the reverse containment.

---

## Caveat 2 — `synapseView.ts` (1393) and `view/sessionSidebar.ts` (1079) not analysed in depth

Closed, and the answer is not the one the line count suggests.

### These are not six modules; they are one class assembled by prototype injection

The five files in `src/view/` do not compose with `SynapseView` — they **inject into** it, via
TypeScript declaration merging plus prototype assignment:

```ts
declare module '../synapseView' {
	interface SynapseView { buildSessionSidebar(parent: HTMLElement): void; /* …25 more */ }
}
export function installSessionSidebar(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SynapseView;
	proto.buildSessionSidebar = function (parent) { /* … */ };
}
```

`synapseView.ts` ends with five `installX(SynapseView)` calls. The result:

| | |
|---|---|
| Methods on `SynapseView` | **140** (32 declared in the class, **108 injected from 5 other files**) |
| Class-level fields | **111** |
| Of those, `private` | **0** |

Zero fields are private, and they cannot be: `private` is per-class, so a method assigned onto
the prototype from another file cannot see one. The mechanism *forces* all 111 fields public.
That is a structural cost, not an oversight.

### But the decomposition underneath it is good — and that is the finding

Mapping each of the 111 fields to the view files that touch it:

| Fields touched by | Count |
|---|---|
| no view file (`synapseView.ts` only) | 15 |
| exactly **one** view file | **56** |
| two | 33 |
| three | 6 |
| four | 1 (`plugin`) |

**56 fields have exactly one external owner.** The split is largely clean along state lines —
each view file really does own its own slice. Only 7 fields are shared by three or more
(`plugin`, `skills`, `sessionList`, `isStreaming`, `configDirty`, `chatContainer`, `agents`),
and that small set is approximately the interface a real composition would need.

The verdict: **the decomposition is right and the mechanism is wrong.** Genuine sub-components
(a `SessionSidebar` holding its own 47 fields, taking a narrow view context) would express the
same split with 56 fields becoming private and the 7 shared ones becoming an explicit, named
interface.

### From outside, `SynapseView` is already a deep module

This is the part that argues against a rewrite. Of 251 members (140 methods + 111 fields), the
four non-`view/` importers touch **15 — six percent**:

- fields: `agents`, `inputEl`, `models`, `plugin`, `sendBtn`, `sessionNames`
- methods: `getVaultBasePath`, `addSelectionAttachment`, `openSearchWithScope`,
  `registerInlineSession`, `setPromptText`, `setScope`, `setWorkingDir`,
  `refreshProviderModels`

The 111-field public surface is an artifact of the injection mechanism, contained entirely
within `src/view/`. It does not leak. The two genuine leaks are `inputEl` and `sendBtn` —
`editorMenu.ts` and `editModal.ts` reach in to raw DOM elements rather than calling a method,
where `setPromptText` already exists and is the shape the other call sites use.

### The mechanism fails silently, exactly like F1 — proven

A method declared in a `declare module` block with **no** `proto.` implementation compiles
clean, and so does every caller. Verified empirically at `e6acb71`: adding
`neverImplemented(): void;` to the sidebar's declaration block and calling it from
`synapseView.ts` produced **no `tsc` error**. It would throw `is not a function` at runtime.
The same holds if a future sixth view file's `installX(SynapseView)` call is forgotten — every
method it declares and implements would simply never attach.

Two checks *are* enforced, because `proto` is cast to `SynapseView`: assigning an undeclared
name errors (TS2551), and a signature mismatch errors. And today the discipline holds — all
five files were diffed declaration-against-implementation, and **every declared method is
implemented**, with no strays.

**Recommendation.** Do not rewrite these two files for size. The external interface is already
good, and 2,472 lines of `ItemView` DOM code is unremarkable. Two changes are worth making, in
this order:

1. **Add a guard test** in the shape of `sessionEventWiring.test.ts`: assert that every
   `declare module` method name has a matching `proto.<name> =` in the same file, and that
   every view file exporting an `installX` is called from `synapseView.ts`. Cheap, and closes
   a runtime hole the compiler cannot see.
2. **Give `editorMenu.ts` and `editModal.ts` methods instead of `inputEl`/`sendBtn`.** Small,
   and removes the only two members that leak DOM internals past the view boundary.

Converting the injection pattern to real composition is a larger change with a real payoff (56
fields become private) but no urgency — file it, do not schedule it.

---

## Caveat 3 — unchanged

No behavioural claim was taken from the specs. Every claim here was checked against `src/` at
`e6acb71`; the two compiler claims were checked by running `tsc`, and the working tree was
restored afterwards (377 tests passing, `git status` clean).

---

## What changed in the recommended order

F1 moves up. The first pass called it "the one worth scheduling rather than waiting for a third
occurrence" — the third occurrence had already happened and was sitting in the code.

1. **Fix `skill.invoked`** (dispatch it) or delete its five files of handler code. A decision,
   not a refactor. Same question for `session.compaction_start`.
2. **F1 — type the session-event seam.** Now fixes a demonstrated class of bug in both
   directions, not one.
3. **View-injection guard test** — cheap, same failure mode, different seam.
4. F2 / F5 / F4 / F3 as previously ordered.
