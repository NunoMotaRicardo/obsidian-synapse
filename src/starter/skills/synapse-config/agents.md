# Agents

File location: `_synapse/agents/<kebab-name>.md`

Frontmatter fields:
- `description` (required) — short purpose summary shown in UI dropdowns
- `model` (optional) — model ID or reference
- `tools` (optional) — list of allowed tools (omit for all, empty list `[]` for none)
- `skills` (optional) — list of allowed skill names (omit for all, empty list `[]` for none)

Body: System instructions defining the agent's persona and behavior.

Example:
```markdown
---
description: Specialty agent for academic citation and research drafting.
tools:
  - Read
  - Write
---

# Academic Research Agent

You are an expert academic research assistant. Always format citations in APA style and maintain an objective tone.
```
