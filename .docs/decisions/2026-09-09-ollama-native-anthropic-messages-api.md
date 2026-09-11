# Ollama's Native Anthropic Messages API Support

> Status: **functional finding, not yet scoped**. Raised from an external change (Ollama blog
> post), not a live elicitation. Hands straight to the technical planner to audit and scope —
> see Hand-off Notes.

## Context

Local models in Synapse run through a **hand-rolled second path**: `executeLocalProviderQuery()`
in [`src/providerModels.ts`](../../src/providerModels.ts) drives its own 5-turn ReAct loop against
Ollama's/OpenAI-compatible presets' native request shapes, documented in
[`wiki/Local-Models-ReAct.md`](../../wiki/Local-Models-ReAct.md). It has none of the Claude Agent
SDK's features — no skills, subagents, sessions, permission modes, streaming, or cost accounting —
because [`AgentService`](../../src/agentService.ts) only talks to the `claude` CLI, and the CLI
only speaks the **Anthropic Messages API**, not the OpenAI-shaped `/v1` surface Ollama has
historically exposed. `AgentService.buildEnv()` has a standing comment (`agentService.ts:550-556`)
stating exactly this constraint and pointing at
[`.docs/audits/2026-09-03-provider-matrix.md`](../audits/2026-09-03-provider-matrix.md) §6,
which already recommended closing the gap with an **"Advanced → Local agent gateway"** setting: a
user-supplied URL for a third-party Messages-API-translating proxy (e.g. LiteLLM) sitting in front
of Ollama, so local models could run through the full Agent SDK. That recommendation was never
built.

The [Claude Agent SDK migration decision](2026-06-28-claude-agent-sdk-migration.md) independently
leaned on the same constraint: it justified routing cheap/local delegation through an in-process
tool rather than a native subagent specifically because "routing a subagent to a local model would
require the same Anthropic-compatible proxy hack the whole posture avoids."

**What changed:** per [Ollama's blog post](https://ollama.com/blog/claude), **Ollama v0.14.0+
implements the Anthropic Messages API natively** — no third-party proxy required. Pointing an
Anthropic client at `http://localhost:11434` with `ANTHROPIC_API_KEY=ollama` (value required but
ignored) gets messages/multi-turn, streaming, system prompts, tool calling, extended thinking, and
vision, and Ollama's own docs confirm Claude Code itself can be run this way. This is the same
"Local Ollama Gateway" pattern already relied on in
[`2026-06-26-ollama-cloud-models-support.md`](2026-06-26-ollama-cloud-models-support.md) (route
through the one local daemon at `:11434` rather than adding plugin-side integration) — except now
that daemon can act as the Messages-API gateway itself, for local **and** Ollama Cloud models
alike, with zero extra moving parts.

This removes the "requires a fragile/third-party proxy" premise behind two standing decisions at
once: the deferred local-agent-gateway feature, and the tool-not-subagent call in the SDK
migration.

## Decision

Not deciding the technical design here. What *is* decided: this is worth a proper audit and scope,
not a quick patch — because it touches a stated architectural premise in two prior decisions, not
just one config option. Handing to `synapse-technical-planner` to:

1. Verify the claim directly (Ollama version behavior, not just the blog post) against whatever
   Ollama version the user/dev environment actually has, since "recommend a model with ≥32K
   context" and feature completeness (tool calling, vision, extended thinking) may vary by model,
   not just daemon version.
2. Decide whether this obsoletes the third-party-proxy "Local agent gateway" design in
   `2026-09-03-provider-matrix.md` §6 outright, or whether that setting should still *support* an
   arbitrary gateway URL (LiteLLM, Ollama, or otherwise) with Ollama's own address just becoming
   the common/default case.
3. Decide whether `executeLocalProviderQuery`'s bespoke ReAct loop should be retired (fully or
   partly) in favor of routing local models through `AgentService`/the real Agent SDK when the
   gateway is configured, or whether the two paths should coexist (simple loop for zero-config use,
   Agent-SDK path for users who opt into the gateway setting).
4. Re-examine whether the "delegation via tool, not native subagent" call in the SDK migration
   decision still holds now that a same-machine, zero-extra-dependency Messages-API endpoint for
   local models exists — or whether native subagents pointed at a local-backed Messages API
   endpoint are now viable for the dynamic-delegation mode.

## Rationale

- **Why hand off rather than just adding the setting:** the provider-matrix research already
  specified the setting's shape; the part that needs judgment now is *scope creep control* — this
  touches `AgentService.buildEnv()` (currently intentionally CLI-only), the vault-local
  customization model's native-primitive mapping, and a rationale line in a completed migration
  decision. That is exactly the kind of cross-cutting change `synapse-technical-planner` exists to
  size and possibly split, not something to wedge into a single-issue lite pass.
- **Why not treat it as purely additive:** if local models can now run through the real Agent SDK,
  the existing local ReAct loop and its wiki page stop being the only story for local-model
  tool-use — that's a user-facing behavior change (streaming, real tool_use blocks, no 5-turn cap)
  worth deciding deliberately, not something that should silently become "the way it works now" as
  a side effect of a config-setting PR.
- **Why the two prior decisions matter here:** both explicitly reasoned from "no Messages-API
  gateway exists without a fragile proxy." Silently outdating that premise without revisiting where
  it was used risks specs and code drifting from the rationale that's still written down as current.

## Scope / Non-goals

- **Not deciding** whether to build the gateway setting, retire the local ReAct loop, or change
  subagent routing — all technical-planning questions.
- **Not verifying** the Ollama behavior firsthand in this record — that verification is item 1 of
  the hand-off, not done here.
- **Not touching** Ollama Cloud model routing, which already works via the same local daemon per
  `2026-06-26-ollama-cloud-models-support.md` and is unaffected either way.

## Open Questions

- Does Ollama's Messages API support cover everything the Agent SDK needs from a model backend
  (tool_use loops well enough for skills/subagents, not just single-turn tool calls)? The local
  ReAct loop's 5-turn cap and "cheap one-shot fallback" exist because local models are historically
  weak at multi-turn tool use — that weakness doesn't disappear just because the transport now
  matches.
- Should the "Local agent gateway" setting name/describe itself as generically as
  `2026-09-03-provider-matrix.md` intended, or default straight to `http://localhost:11434` given
  Ollama itself is now usually sufficient?
- Minimum Ollama version to require/detect if this ships (blog post says v0.14.0+).

## Hand-off Notes for the Technical Planner

1. Read [`.docs/audits/2026-09-03-provider-matrix.md`](../audits/2026-09-03-provider-matrix.md)
   §6 in full before scoping — this record extends it, doesn't replace it.
2. Audit `AgentService.buildEnv()` (`src/agentService.ts:545-567`) and its dead
   `forLocalModel` history noted in the research doc.
3. Audit `executeLocalProviderQuery()` and the ReAct loop in `src/providerModels.ts` for what, if
   anything, becomes redundant.
4. Re-read the "Why delegation is via a tool, not a native subagent" rationale in
   [`2026-06-28-claude-agent-sdk-migration.md`](2026-06-28-claude-agent-sdk-migration.md) and note
   in the resulting spec/issue whether it still holds or needs a follow-up decision record of its
   own (this record does not overrule it — that call needs its own scoping pass, possibly its own
   brainstorm if it changes product posture).
5. Update `specs/agent-service.md` in lockstep with whatever ships, per CLAUDE.md.
6. Size this as its own issue (or split) rather than folding it into unrelated work — it is
   cross-cutting by nature (settings, `AgentService`, `providerModels.ts`, and a prior decision's
   rationale).

## Related

- [`2026-06-28-claude-agent-sdk-migration.md`](2026-06-28-claude-agent-sdk-migration.md) — the
  tool-not-subagent rationale this record calls into question.
- [`2026-06-26-ollama-cloud-models-support.md`](2026-06-26-ollama-cloud-models-support.md) — the
  "route everything through the local Ollama daemon" pattern this reuses.
- [`2026-06-25-ollama-support-and-multimodal.md`](2026-06-25-ollama-support-and-multimodal.md) —
  original local-model + multimodal phase plan.
- [`.docs/audits/2026-09-03-provider-matrix.md`](../audits/2026-09-03-provider-matrix.md) §6 —
  the gateway design this record's finding simplifies.
- [`wiki/Local-Models-ReAct.md`](../../wiki/Local-Models-ReAct.md) — current local-model loop
  documentation, to be revisited depending on the planner's scope decision.
- [Ollama blog: Claude Code + Ollama](https://ollama.com/blog/claude) — source of the finding.
