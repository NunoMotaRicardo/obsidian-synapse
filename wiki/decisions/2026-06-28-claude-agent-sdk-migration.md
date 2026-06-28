# Migrate from the GitHub Copilot SDK to the Claude Agent SDK

> Status: **functional decision agreed** (business-side brainstorm, 2026-06-28). Technical
> roadmap, sequencing, and the detailed loop-feature design are explicitly deferred to later
> rounds — see Open Questions and Hand-off Notes.

## Context

Sidekick today routes **all** model access through `CopilotService` (`src/copilot.ts`), which
drives a system-installed `copilot` CLI via the `@github/copilot-sdk`. That SDK doubles as a
**universal provider router**: the plugin's provider-agnosticism (GitHub Copilot, plus BYOK
presets for OpenAI, Azure, Anthropic, Ollama, Microsoft Foundry Local, and generic
OpenAI-compatible endpoints) is *delivered by the Copilot SDK*, not built by us. Local-model
support (Ollama/Foundry Local) exists **because** the Copilot CLI routes to those endpoints.

The question raised: should the plugin migrate to the **Claude Agent SDK** instead? A brainstorm
on 2026-06-28 worked the business/product side of that question to a conclusion. The key early
finding that shaped everything: the Claude Agent SDK is **not** a universal provider router. Its
native model story is Claude (Anthropic API, plus Bedrock/Vertex as transports for the same
Claude models); it has **no** first-class BYOK presets for other cloud vendors, and reaching
non-Claude cloud models would require a fragile Anthropic-API-compatible proxy. So "migrate to
the Claude Agent SDK" and "stay cloud-agnostic" are in direct tension, and the brainstorm
resolved that tension deliberately rather than trying to keep both.

## Decision

### Driver
Migrate for **capability** and **positioning**, not for operational pain or raw cost:
- **Capability** — the plugin should gain the Claude Agent SDK's native agentic primitives
  (subagents, skills, hooks, MCP tools, sessions) and a new product surface ("Claude loops").
- **Positioning** — the product becomes genuinely **Claude-native**, aligned with the stack the
  author already builds on, and ultimately released as an open-source community project.

### Provider posture
- **Claude is the only cloud vendor.** The agnostic cloud BYOK matrix (OpenAI, Azure, GitHub
  Copilot backends) is **dropped**.
- The **Copilot SDK is fully removed** — not run side-by-side with the Claude Agent SDK.
- **Local models stay**, universally (personal *and* public builds), as the private / zero-cost
  option. "Claude-only" means *Claude is the only cloud AI vendor*; local models are a
  first-class complement, not a competing provider.
- **Authentication is user-selectable: Claude subscription (OAuth) _or_ Anthropic API key.**

### Audience / build model
- **Personal-first**, then released as an **OSS community project** with **no support
  commitment**.
- The personal/public distinction collapses to essentially a **rename** plus the public release;
  it is not two divergent feature sets. (The product's current "copilot" identity no longer fits
  once the GitHub Copilot backend is gone — a rename is expected; new name TBD.)

### Architecture (conceptual — not technical design)
- The routing primitive is **not a hardcoded tier**. It is a **named agent that carries its own
  model binding**. This is a *single unified concept* — an extension of today's vault-local
  `agents/*.agent.md` model, with a new per-agent model binding. (Option A of the
  "one concept vs two" fork: a tool-less, single-turn agent *is* the lightweight handler; we do
  not introduce a separate "capability/profile" type.)
- **Settings holds a feature → agent map.** The plugin ships **one or two default agents** that
  handle everything out of the box; power users remap individual features to other agents and
  rebind each agent's model. Customization is optional, not required.
- **Lightweight features never hard-depend on local-model availability.** A handler agent
  *defaults* to a Claude model (e.g. Haiku) and points at a local model only by user choice.
  "Cheap tier" is therefore just *an agent whose configured model happens to be local* — not a
  separate plumbing layer.
- **Image reading is not lightweight** and gets its own **vision-capable** handler agent (a
  Claude vision model, or a local VLM by choice).
- **Three routing modes coexist**, each on its own surface:
  1. **Static** feature→agent map (Settings) — predictable, cost-safe defaults.
  2. **Manual** per-message model/agent picker (chat sidebar) — human is present and choosing.
  3. **Dynamic** delegation (when tier-1 Claude is already working, it can offload sub-work to a
     local-backed agent **via a tool**, *not* a native subagent — see Rationale).
- **Loops are plugin-orchestrated**, not autonomous local-model loops: the orchestration layer
  (today's `CopilotService`) owns the iteration, cost caps, cancellation, and progress — calling
  the chosen agent once per iteration.
- **The migration's target is capability expansion** (reached incrementally): the vault-local
  customization model re-bases onto the SDK's *native* primitives —

  | Vault-local `sidekick/` (today) | Claude Agent SDK native |
  |---|---|
  | `agents/*.agent.md` | subagents |
  | `prompts/` | system prompts / skills |
  | `skills/` | skills |
  | `tools/` | MCP tools |
  | `triggers/` | hooks |

  i.e. a user-authored skill becomes a real Claude skill, a user tool becomes a real MCP tool,
  a trigger becomes a real hook — instead of being flattened into whatever the Copilot SDK
  accepted.

### Feature disposition
- **Removed:** ghost text / inline completion (worst fit for an agent SDK; Claude is not a
  fill-in-the-middle model; removing it also deletes the FIM-model problem). Also removed with
  the Copilot SDK: the GitHub Copilot cloud backend and the cloud BYOK matrix.
- **Retained, re-homed onto agents:** chat, editor actions (rewrite / structure), image reading,
  triggers, Telegram bot.
- **New surfaces unlocked:** Claude loops (tier-1 autonomous iteration), real subagent
  delegation, hooks, native skills/MCP.

## Rationale

- **Why Claude-only cloud, not dual-stack:** keeping the Copilot SDK alongside the Agent SDK
  (the rejected "Option C") doubles the runtime surface, the auth story, and the maintenance
  burden to preserve agnosticism the author does not value enough to fight for. The
  agnosticism in the codebase today was *inherited* from upstream and handed over for free by
  the Copilot SDK; it was never a deliberate product bet.
- **Why local models survive anyway:** the real need behind "support Ollama" is **tiered cost /
  rate-limit control** — pushing high-volume, low-stakes work (especially long-running automated
  loops) onto a cheap, private model so it does not consume the premium Claude budget. With a
  personal **subscription (OAuth)** tier-1, the value of a local tier is specifically *not
  burning the subscription's rolling rate-limit windows on bulk loops*; with an **API-key**
  tier-1 it is dollar cost. Either way the local rung pays for itself, so it stays.
- **Why "agent with model binding" instead of hardcoded tiers:** lightweight tasks must keep
  working with zero local setup (so they default to a Claude model), some "lightweight" tasks
  are not light (image reading needs vision), and the author wants to customize both *behavior*
  and *model* per task. A named agent with its own model binding satisfies all three; a
  hardcoded tier does not. Reusing the existing agent concept (not inventing a parallel
  "capability") keeps one mental model and one docs surface.
- **Why delegation is via a tool, not a native subagent:** the Claude Agent SDK's native
  subagents run on Claude-family models only; routing a subagent to a local model would require
  the same Anthropic-compatible proxy hack the whole posture avoids. Exposing the cheap/local
  agent as a **tool** (an in-process MCP tool such as `cheap_generate` / `bulk_summarize`) lets
  tier-1 Claude offload work while the plugin keeps explicit control of routing and cost — the
  standard "model cascade / LLM-as-tool" pattern, and provider-agnostic by construction.
- **Why loops are plugin-orchestrated:** deterministic iteration owned by plugin code gives hard
  cost caps, cancellation, and progress reporting that an autonomous local-model loop cannot;
  local models are also unreliable at self-direction. (Dovetails with the existing
  active-cancellation / adaptive-timeout work.)
- **Why remove ghost text:** per-keystroke agent turns are heavy, slow, and costly; Claude is
  not a FIM model. The feature was the single worst fit and the author chose to drop it
  outright rather than degrade it onto a local model.
- **Why capability expansion is the target, not a bare engine swap:** capability *is* the
  stated driver (B). The vault-local customization model already mirrors the Agent SDK's native
  primitives almost 1:1, so leaning into that mapping is the literal substance of the
  migration's value. Committing to it as the *target* (even while delivering incrementally)
  keeps the engine-swap work from painting the native mapping into a corner.

## Scope / Non-goals

- **Not deciding the technical roadmap or sequencing here** — whether this lands as a phased
  migration or a larger rework, module-by-module ordering, and all API-shape decisions belong to
  the technical-planning round.
- **Not designing the loop features here.** Two distinct loop concepts were identified and are
  to be **co-designed later**:
  1. **Tier-2 cost loops** — batch vault operations ("run this prompt over every note in folder
     X") *and* scheduled / recurring unattended runs; cheap, plugin-orchestrated.
  2. **Tier-1 "Claude loops"** — a new premium feature derived from the Agent SDK's autonomous
     agentic iteration.
- **Not choosing the new product name.**
- **Not keeping** the cloud BYOK matrix, the GitHub Copilot backend, the Copilot SDK, or ghost
  text.
- **Not committing** to public-grade onboarding/support polish (managed CLI install, polished
  auth flows) — public is OSS, community-supported.

## Open Questions

- **Loop-feature design** (both kinds above) — deferred to a dedicated round.
- **New name / rebrand.**
- **Agent SDK overhead on single-shot work** — a tool-less, single-turn agent invocation must be
  cheap enough that re-homing editor actions / image reading onto agents does not add meaningful
  latency or cost. To validate during technical planning.
- **Local-model tool-use reliability** for the dynamic-delegation (mode 3) path — local models
  are weak at function calling; how robust does the tool-bridge need to be, and what is the
  fallback when a local-backed agent is asked to use tools?
- **Whether to slim the `.agents/agents/` developer-tooling roster** (separate concern, noted
  during the session): the bespoke `sidekick-analyst` and `sidekick-technical-planner` agent
  definitions are being run directly in the main thread for this work rather than spawned, since
  the context is warm and their marquee modes (live interview; freshly-decided planning) do not
  benefit from a cold subagent. This is a workflow decision, not part of the migration.

## Hand-off Notes for the Technical Planner

Functional intent to turn into `specs/` updates and GitHub issues (no technical design above —
module names, file paths, and API shapes are the planner's job):

1. **Introduce a model-routing abstraction** in the orchestration layer (evolves from
   `CopilotService`) with the notion of a **named agent carrying a model binding**, reachable
   from all three surfaces (settings map, chat picker, dynamic tool delegation).
2. **Add a feature → agent map to Settings**, with one or two shipped default agents that cover
   every feature, and per-agent model binding (Claude model *or* local endpoint). Lightweight
   features must default to a Claude model so they work with no local setup.
3. **Replace the Copilot SDK with the Claude Agent SDK** as the tier-1 backend; **fully remove**
   the Copilot SDK, the GitHub Copilot backend, and the cloud BYOK matrix. Preserve **local
   models** as a configurable agent backend via a thin OpenAI-compatible side channel.
4. **Support dual auth** (Claude subscription OAuth / Anthropic API key) as a user setting.
5. **Expose the cheap/local agent to tier-1 as a tool** (in-process MCP tool) for dynamic
   delegation — not as a native subagent.
6. **Remove ghost text** end to end (settings, editor wiring, specs).
7. **Re-base the vault-local customization model** (`configLoader.ts`: agents / prompts / skills
   / tools / triggers) onto the Agent SDK's native subagents / skills / MCP tools / hooks — as
   the *target*, deliverable incrementally; do not let the initial engine swap make this mapping
   harder later.
8. **Keep loop design out of the first plan** — flag the two loop concepts (above) as their own
   future work items.
9. Update the matching `specs/<module>.md` files in lockstep with each change, per CLAUDE.md.

## Related

- [`2026-06-15-byok-model-discovery.md`](2026-06-15-byok-model-discovery.md) — the BYOK cloud
  matrix this decision retires (local-model discovery logic is reusable for the surviving local
  path).
- [`2026-06-25-ollama-support-and-multimodal.md`](2026-06-25-ollama-support-and-multimodal.md) —
  the local-model + provider-agnostic multimodal work; the multimodal/image-reading intent
  survives, re-homed onto a vision-capable handler agent.
- [`../ai-customization-guide.md`](../ai-customization-guide.md) — the vault-local customization
  model that re-bases onto native Agent SDK primitives.
- `.claude/skills/copilot-sdk-reference/` — to be superseded by a Claude-Agent-SDK reference once
  the migration is planned.
