# Competitive landscape: Claude + Obsidian

## Why this exists

The rebuild of this plugin into a Claude-native agent (see
[`.docs/decisions/2026-06-28-claude-agent-sdk-migration.md`](../decisions/2026-06-28-claude-agent-sdk-migration.md))
enters a space that already has notable Claude + Obsidian projects. This note captures the two
most relevant as of **2026-06-28**, what we can learn from them, and where the open niche is.
It is a living guide — update it as the landscape shifts.

## The two reference projects

### 1. `AgriciDaniel/claude-obsidian` — the knowledge engine

| | |
|---|---|
| Stars / forks | **8,071** / 929 |
| Language / license | Python / MIT |
| Created → last push | 2026-04-07 → 2026-05-28 (active) |
| Form factor | **Not** an in-Obsidian plugin — a **Claude Code skill-pack + structured vault**. You run Claude Code *in the vault folder*. |

A "self-organizing AI second brain" based on Karpathy's LLM Wiki pattern. It is a **knowledge
engine, not a chat UI**: drop a source and Claude extracts entities/concepts, builds
cross-references, and files everything into a structured vault that compounds over time.

Notable capabilities:

- **Self-organizing ingestion** — entities, concepts, automatic cross-linking.
- **Hot-cache session memory** — recent context persisted to the vault so the next session starts warm.
- **8-category vault lint** — orphans, dead links, stale claims, missing cross-references.
- **Autonomous research loop** — multi-round web research with gap-filling.
- **Methodology modes** — LYT / PARA / Zettelkasten / Generic as first-class options.
- **Hybrid retrieval** — contextual-prefix + BM25 + cosine rerank (per Anthropic's contextual-retrieval research).
- **Per-file advisory locking** — multi-writer corruption safety.
- **Contradiction flagging**, a 10-principle thinking framework, and a canvas/graph companion.

Caveat: the star count is partly **marketing-driven** (SEO, blog, YouTube, a paid Skool
community), so treat 8k as "real but inflated." Still clearly the mindshare leader.

### 2. `deivid11/obsidian-claude-code-plugin` — the head-on plugin

| | |
|---|---|
| Stars / downloads | 83 ★ / **15,756 downloads** (v2.0.0) |
| Language / license | TypeScript / MIT |
| Created → last push | 2025-11-10 → 2026-01-11 (**stale**, ~5 months) |
| Form factor | A **true Obsidian plugin** wrapping the **`claude` CLI** (and OpenCode) as the agent backend. |

This is essentially the product we are about to build. It validates the core technical bet — a
CLI-backed Claude agent runs fine inside an Obsidian plugin, and there is real demand.

Notable capabilities:

- **Diff preview before apply** — Raw / Rendered / Diff toggle.
- **Task / plan tracking UI** — renders the agent's plan and live progress.
- **Sessions tab** — global session list, live "running" indicators + elapsed time, per-note
  sessions, note-linking that survives rename/move, resumption across restarts.
- **Permission modes** — interactive vs permissionless.
- **Multi-backend** — Claude Code **+ OpenCode** (OpenCode adds OpenAI/Anthropic/etc.), a
  precedent for multi-provider *without* an Anthropic-compatible proxy.
- **"Zero external dependencies"** onboarding — just install the CLI.

## Are they competing? Good? Used?

- **deivid11 — head-on competitor.** Same category as our plugin. Solid engineering and real
  usage (15k downloads), but **appears stalled** (no commits since Jan 2026), only 83 stars, and
  not yet in the community store (PR #8730). Opportunity: a *maintained*, more capable take.
- **AgriciDaniel — adjacent, not head-on.** Same user goal (AI second brain in Obsidian) but a
  different form factor (lives in Claude Code + vault folder, not an Obsidian panel). It is the
  benchmark for *where the value is*, not a like-for-like UI rival. Genuinely strong and heavily
  adopted.

## Ideas we are adopting

Folded into the migration backlog on `NunoMotaRicardo/obsidian-claude-brain` (2026-06-28):

| Idea | Source | Issue |
|---|---|---|
| Methodology-tuned default agents (LYT/PARA/Zettelkasten/Generic) | AgriciDaniel | #6 |
| Diff preview before apply (Raw/Rendered/Diff) | deivid11 | #12 |
| Self-organizing ingestion (batch loop) | AgriciDaniel | #14 |
| Automated vault lint (cheap-local loop) | AgriciDaniel | #14 |
| Autonomous research loop (tier-1 Claude loop) | AgriciDaniel | #14 |
| Hot-cache session memory | AgriciDaniel | #14 |
| Task / plan tracking UI | deivid11 | #14 |
| Per-file advisory locking (multi-writer safety) | AgriciDaniel | #14 |

## Strategic positioning

There is a clean, unoccupied niche between the two: **deivid11's form factor (a maintained
in-Obsidian plugin) with AgriciDaniel's ambition (a knowledge engine that organizes, maintains,
and researches — not just chats).** That is essentially our plan.

The market signal is unambiguous: **plain chat/edit plugins plateau (deivid11); the
auto-organize + loops angle is what earns mindshare (AgriciDaniel).** This validates prioritizing
the **loop features** and the **customization re-base** as the differentiators, and treating
chat/edit as table stakes.

## Suggested reading

- [AgriciDaniel/claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) and its
  [deep-dive blog post](https://agricidaniel.com/blog/claude-obsidian-ai-second-brain).
- [deivid11/obsidian-claude-code-plugin](https://github.com/deivid11/obsidian-claude-code-plugin).
- [Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — the pattern behind claude-obsidian.
- [Anthropic: Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) — the retrieval approach claude-obsidian uses.
- [`.docs/decisions/2026-06-28-claude-agent-sdk-migration.md`](../decisions/2026-06-28-claude-agent-sdk-migration.md) — our migration decision this scan informs.
