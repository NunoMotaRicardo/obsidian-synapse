# Skills

File location: `_synapse/skills/<kebab-name>/SKILL.md`

Frontmatter fields:
- `name` (required) — skill identifier (used for slash commands like `/synapse-config`)
- `description` (required) — short description of what this skill teaches the agent

Body: Detailed procedures, reference material, workflows, or prompt instructions.

Example:
```markdown
---
name: apa-citations
description: Teaches the agent to format references according to APA 7th edition guidelines.
---

# APA Citation Formatting Skill

When this skill is active or invoked, format all references and in-text citations following APA 7th edition standard rules.
```

## Writing a Good Skill

A skill exists to make the agent take the same **process** every run — **predictability**, not identical output. Everything below serves that.

### Invocation is not optional

Synapse only reads `name` and `description` from a skill's frontmatter — there's no field to hide a skill from autonomous discovery (no Claude-Code-style `disable-model-invocation`). Every skill you write is always model-invoked: its description sits in context on every turn, for every conversation, whether or not the skill ever fires. There's no cheap "user-invoked" escape hatch, so pruning the description isn't a nice-to-have — it's the one lever you always pay for.

### Writing the description

The description does two jobs: say what the skill is, and list the distinct situations that should trigger it.
- **Front-load the leading concept** — the first words are where it does its invocation work.
- **One trigger per distinct situation.** Don't restate the same trigger with a synonym ("build with TDD … asks for test-first development" is one trigger written twice).
- **Cut anything the body already says.** The description is triggers only, not a summary of the skill's identity.

### Information hierarchy

A skill mixes two kinds of content: **steps** (ordered actions, each ending on a completion criterion the agent can check) and **reference** (facts/rules consulted on demand). Rank material by how urgently the agent needs it:
1. In `SKILL.md` directly — needed on (almost) every run.
2. Pushed to a sibling file in the skill folder, linked from `SKILL.md` — needed only on some branches. `agents.md`, `skills.md`, and `setup.md` inside `synapse-config/` are an example of this: each is loaded only when that branch of the work is actually reached.

A completion criterion should be checkable ("every field in the frontmatter table is filled in") not vague ("frontmatter looks good") — vague criteria invite the agent to call the step done before it is.

### When to split into a new skill

In most skill systems, splitting off a new skill can be free if it's user-invoked only. In Synapse it never is — a new skill is always an always-on description cost, since there's no user-invoked mode to offset it. So only split into a **separate** skill when another skill genuinely needs to reach it independently, or the two skills fire on truly disjoint triggers. Otherwise, split within one `SKILL.md` by pulling out a later step's detail into a sibling reference file — that's free, and it discourages the agent from skimming ahead to steps not yet reached.

### Pruning

- **Single source of truth** — say each rule once; if it needs to change, there should be exactly one place to edit.
- **Relevance** — every line should still describe what this skill actually does.
- **No-ops** — test each sentence: does it change the agent's behavior versus what it would already do by default? "Be careful" and "make sure it's correct" are usually no-ops; delete rather than reword them.

### Leading words

A leading word is a familiar concept (e.g. "checklist," "dry run," "red flag") that the model already has strong priors about, so one word carries what would otherwise take a sentence to spell out. Reuse the same word everywhere it applies in a skill instead of re-describing the idea each time — it compresses the description and gives the agent a consistent hook to reason with.

### Failure modes to watch for

- **Premature completion** — the agent calls a step done early. Fix the completion criterion first; only split the step into its own skill/section if the criterion genuinely can't be sharpened.
- **Duplication** — the same rule stated in two places; costs tokens and drifts out of sync.
- **Sediment** — old instructions kept because removing them feels riskier than leaving them; prune on every edit, not just when adding.
- **Sprawl** — the skill is too long even with no duplication; push reference material to sibling files (see Information hierarchy above).
- **Negation** — "don't do X" tends to draw attention to X. State the wanted behavior directly; keep a bare prohibition only for a hard rule with no positive phrasing.
