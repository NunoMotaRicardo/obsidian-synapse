# Drop the OpenAI-Compatible Provider Matrix and Batch-Loop; Anthropic Messages API Only

> Status: **functional decision, user-directed**. Follows directly from
> [`2026-09-09-ollama-native-anthropic-messages-api.md`](2026-09-09-ollama-native-anthropic-messages-api.md).
> Technical roadmap, sequencing, and file-level removal plan are deferred to the technical
> planner — see Hand-off Notes.

## Context

Synapse currently has **two parallel model-access paths**:

1. **`AgentService`** (`src/agentService.ts`) — the Claude Agent SDK path. Talks JSON-RPC to the
   `claude` CLI, which speaks only the Anthropic Messages API. Full feature set: skills, subagents,
   sessions, permission modes, streaming, cost accounting.
2. **The OpenAI-compatible local-provider path** (`src/providerModels.ts`,
   `executeLocalProviderQuery()`) — a hand-rolled, stateless, 5-turn-capped ReAct loop that talks
   to Ollama's/OpenAI-compatible endpoints' native request shapes directly via Obsidian's
   `requestUrl()`. This is the umbrella the **Ollama preset and the generic "OpenAI-compatible"
   preset** both sit under — the latter covering LM Studio, llama.cpp, vLLM, Foundry Local, and
   Azure, per `wiki/Local-Models-ReAct.md` and the migration decision's provider posture.

Path 2 exists, per the [SDK migration decision](2026-06-28-claude-agent-sdk-migration.md), because
local models are the private/zero-cost tier and — at the time — reaching them through the real
Agent SDK required "a fragile Anthropic-API-compatible proxy," which the plugin was not going to
build or depend on. **`2026-09-09-ollama-native-anthropic-messages-api.md` establishes that this is
no longer true**: Ollama v0.14.0+ speaks the Anthropic Messages API natively at
`http://localhost:11434`, no proxy required.

**Batch-loop** (`src/batchLoopExecutor.ts`, `specs/batch-loops.md`, plus its call sites in
`src/runExecutor.ts`, `src/lockManager.ts`, `src/budget.ts`, `src/bots/telegramBot.ts`,
`src/modals/batchLoopProgressModal.ts`, `src/main.ts`) is the plugin-orchestrated iteration
feature the migration decision labelled "tier-2 cost loops": running a prompt over many vault
notes cheaply, historically leaning on the local ReAct loop's low cost/no rate-limit pressure to
be affordable at volume.

## Decision

Per user direction (2026-09-09), acting on the Ollama finding rather than just filing it as an
open question:

1. **Remove the entire OpenAI-compatible provider matrix** — the generic "OpenAI-compatible"
   preset and everything under it (LM Studio, llama.cpp, vLLM, Foundry Local, Azure), *and* the
   dedicated Ollama-native-shape handling in `executeLocalProviderQuery()`. Local models are
   reached going forward **only** as an Anthropic-Messages-API-speaking endpoint — in practice,
   pointing `AgentService`/the `claude` CLI's `ANTHROPIC_BASE_URL` at Ollama's native Messages API
   (`http://localhost:11434`, `ANTHROPIC_API_KEY=ollama`) or, in principle, any other endpoint that
   speaks that same API.
2. **Remove batch-loop entirely** — no replacement feature in this change. The user will connect
   to Ollama through the Messages-API path above, which removes the original cost/rate-limit
   motivation for a separate cheap-tier loop; if a "loops" feature is wanted later it is the
   still-undesigned "Claude loops" concept from the migration decision, a distinct future
   decision, not something this removal should try to preserve a stub of.
3. **Single provider model going forward:** Claude (subscription OAuth or Anthropic API key) and
   any Anthropic-Messages-API-compatible endpoint (Ollama being the concrete case), both routed
   through `AgentService`. No other provider shape survives.

## Rationale

- **Why remove the whole preset, not just literal OpenAI:** the generic "OpenAI-compatible" preset
  and the Ollama preset share the same `executeLocalProviderQuery()` machinery and the same
  underlying problem the SDK migration already flagged as a worse experience (no skills, no
  subagents, no sessions, no streaming, 5-turn cap, "cheap one-shot fallback" for models that can't
  tool-call reliably). Keeping a partial OpenAI-compatible path alive after Ollama's path moves to
  the real Agent SDK would mean maintaining two local-model code paths for no remaining reason —
  the user chose to standardize on one.
- **Why batch-loop goes with no replacement:** batch-loop's reason to exist as a *separate*
  plugin-orchestrated loop was cost/rate-limit isolation from tier-1 Claude, achieved by running
  volume work through the cheap local ReAct loop. Once local models are reached through the same
  Agent SDK sessions as Claude, that isolation rationale weakens, and the user has decided not to
  carry the feature forward speculatively — consistent with the "no half-finished implementations"
  and "don't design for hypothetical future requirements" conventions already in `CLAUDE.md`.
- **Why this is a decision record and not a straight-to-code change:** this reverses concrete,
  written provider-posture language in the SDK migration decision ("local models stay, universally
  ... as the private / zero-cost option" via the OpenAI-compatible matrix) and removes a shipped
  feature with real spec coverage and call sites across ~7 non-test files plus tests. That is
  exactly the class of cross-cutting change `synapse-technical-planner` exists to size, sequence,
  and possibly split into multiple issues (per `CLAUDE.md`'s workflow), not a single lite pass.

## Scope / Non-goals

- **Not deciding** the exact mechanics of how `AgentService.buildEnv()` should accept a
  user-configured Messages-API base URL/key pair for local endpoints — that is the technical
  planner's job, informed by `2026-09-09-ollama-native-anthropic-messages-api.md`'s hand-off notes
  and `.docs/audits/2026-09-03-provider-matrix.md` §6.
- **Not deciding** whether any batch-loop settings/UI remnants (progress modal, Telegram bot
  hooks, budget accounting tie-ins) need a deprecation path for existing users' vault configs, or
  a clean removal — planner's call, but note it explicitly so it isn't missed.
- **Not designing** a future "Claude loops" replacement — out of scope here, as in the original
  migration decision.
- **Not touching** Ollama Cloud model routing (`2026-06-26-ollama-cloud-models-support.md`) beyond
  what naturally follows from local models moving to the Messages-API path — the local daemon at
  `:11434` remains the single gateway for local *and* cloud-hosted Ollama models either way.

## Open Questions

- Does removing the OpenAI-compatible preset also retire any settings/secrets fields
  (`src/settings.ts`) that need a migration note for existing users, or can they simply be dropped
  per the "don't add backwards-compatibility shims" convention?
- Full audit of batch-loop's footprint: `specs/batch-loops.md`, `src/batchLoopExecutor.ts`,
  `src/runExecutor.ts`, `src/lockManager.ts`, `src/budget.ts`, `src/bots/telegramBot.ts`,
  `src/modals/batchLoopProgressModal.ts`, `src/main.ts`, `test/batchLoopExecutor.test.ts`, and any
  wiki pages — is everything cleanly severable, or does `lockManager`/`budget` have other callers
  that must survive?
- Whether `wiki/Local-Models-ReAct.md` is deleted outright or rewritten to describe the new
  Messages-API-only local setup.

## Hand-off Notes for the Technical Planner

1. Treat this alongside `2026-09-09-ollama-native-anthropic-messages-api.md` — that record's
   hand-off notes (items 1–6) largely become the "add the new path" half of this work; this record
   adds the "remove the old paths" half. Together they likely justify splitting into at least two
   issues: (a) local models via Messages API through `AgentService`, (b) removal of the
   OpenAI-compatible matrix + batch-loop. Sequence (a) before (b) so local-model support isn't
   dropped mid-migration.
2. Audit and remove: `executeLocalProviderQuery()` and the OpenAI-compatible preset branch in
   `src/providerModels.ts`; related settings fields in `src/settings.ts`; any UI in
   `src/main.ts`/settings tab for selecting the OpenAI-compatible preset.
3. Audit and remove batch-loop: `src/batchLoopExecutor.ts`, `specs/batch-loops.md`,
   `src/modals/batchLoopProgressModal.ts`, and its call sites in `src/runExecutor.ts`,
   `src/lockManager.ts`, `src/budget.ts`, `src/bots/telegramBot.ts`, `src/main.ts`; remove
   `test/batchLoopExecutor.test.ts` and any other batch-loop-specific tests. Check whether
   `lockManager.ts`/`budget.ts` have non-batch-loop callers that must be preserved.
4. Update `specs/ARCHITECTURE.md`, `specs/run-executor.md`, `specs/agent-service.md`, and any spec
   referencing the OpenAI-compatible matrix or batch-loop, per `CLAUDE.md`'s "update the matching
   spec in the same change" rule. Delete `specs/batch-loops.md` if the feature has no remnant.
5. Update or delete `wiki/Local-Models-ReAct.md` and `wiki/Customization.md` references to the
   OpenAI-compatible preset and batch-loop, and add the new Ollama-via-Messages-API setup guide
   (this may be the same wiki work flagged in the sibling record).
6. Re-check `.docs/audits/2026-09-03-automation-model-beyond-triggers.md`,
   `.docs/audits/2026-09-05-codebase-design-audit.md`, and
   `.docs/audits/2026-09-03-open-source-readiness-code-quality.md` for batch-loop-dependent
   recommendations that need to be dropped or revised as stale once the feature is gone.
7. Size as its own issue(s), not folded into unrelated work, per the same reasoning as the sibling
   record.

## Related

- [`2026-09-09-ollama-native-anthropic-messages-api.md`](2026-09-09-ollama-native-anthropic-messages-api.md) —
  the finding that unlocks this decision.
- [`2026-06-28-claude-agent-sdk-migration.md`](2026-06-28-claude-agent-sdk-migration.md) — the
  provider posture and "tier-2 cost loops" framing this decision revises.
- [`2026-06-26-ollama-cloud-models-support.md`](2026-06-26-ollama-cloud-models-support.md) — the
  local-daemon-as-gateway pattern that continues to apply.
- `specs/batch-loops.md`, `specs/run-executor.md`, `specs/agent-service.md` — specs to be updated
  or removed.
