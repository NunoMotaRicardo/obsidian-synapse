---
name: brain-analyst
description: Synthesize grill-me/brainstorm elicitation into durable product/functional decision records under wiki/decisions/, and keep the wiki/ guides accurate, cross-linked, and proposing further reading (librarian mode). Use in the main thread after an elicitation, or when asked to write up a decision, update a wiki guide, or organize wiki/.
---

# brain-analyst — wiki knowledge base

Use this skill to turn discussion into durable, well-organized knowledge under `wiki/`. Unlike
`.claude/` memory, `wiki/` is version-controlled and shared with anyone reading the repo. This
runs **in the main thread** with warm context — the live one-question-at-a-time interview happens
via `grill-me`/`brainstorm`; this skill is the **writing/synthesis** that follows. For a heavy
read-only sweep of many `wiki/` files (e.g. fixing stale cross-links repo-wide), spawn a generic
`Explore` agent and synthesize its findings here.

> **Naming note:** `wiki/` is plugin-repo documentation for *developing* the plugin. Don't confuse
> it with the vault-local `sidekick/` customization folder (`agents/`, `prompts/`, `skills/`,
> `tools/`, `triggers/`) that `src/configLoader.ts` loads at runtime — that's a product feature,
> documented in `wiki/ai-customization-guide.md`, not this knowledge base.

## Folder ownership

```
wiki/
  decisions/    # dated product/functional decision records
  *.md          # guides, PRDs, setup notes, competitor-landscape.md, ...
  images/       # screenshots referenced from guides
```

Never write to `specs/`, GitHub issues, or `src/` — those belong to `brain-technical-planner` and
`brain-coder`.

## Mode A — Functional analysis (synthesis)

Write one file per significant decision: `wiki/decisions/<YYYY-MM-DD>-<slug>.md`

```markdown
# <Decision title>

## Context
What prompted this — feature idea, fork-vs-upstream tradeoff, SDK change, user pain point.

## Decision
What we decided, in plain language a non-engineer could follow.

## Rationale
Why, including alternatives considered and rejected.

## Scope / Non-goals
What's explicitly out of scope for now.

## Open Questions
Unresolved items.

## Hand-off Notes for the Technical Planner
The functional intent that brain-technical-planner must turn into specs/ updates and GitHub
issues (no technical design here — module names, file paths, or API shapes are the planner's job).
```

If a decision needs a PRD-style writeup, write it as a sibling `wiki/<topic>.md` and link it from
the decision record.

## Mode B — Librarian

- Keep `wiki/*.md` guides accurate as the plugin evolves: when `src/configLoader.ts`, the
  customization model, or setup steps change, update the relevant guides.
- For new topics (an Obsidian API change, an SDK feature, a provider quirk), write/update a guide:
  what it is, why it matters for this fork, and links to authoritative sources.
- Proactively suggest further reading (WebSearch/WebFetch) under a "## Suggested reading" section.
- Keep `wiki/` cross-linked and navigable; fix stale links and references to renamed files/modules.

## Rules
- Confirm material product decisions with the user before recording them as final.
- Keep `wiki/` readable by a non-engineer where possible — plain language; link to `specs/` for
  technical depth instead of duplicating it.
- Never invent results not supported by a source; write "unable to determine" instead.
- Never include secrets/API keys/tokens; use placeholders.
- When synthesis is complete, list the `wiki/` files written and hand functional intent to
  `brain-technical-planner`.
