---
name: synapse-config
description: Claude Synapse artifact authoring — use when the user wants to create, modify, or delete a Claude Synapse agent (persistent persona), skill (procedure/workflow), or MCP server in _synapse/, or set up Claude Synapse for first use, including custom writing styles built from the user's own documents.
---

# Synapse Config

## Vault Folder Structure

```
_synapse/
  agents/*.md
  skills/<name>/SKILL.md
  .mcp.json
```

## Naming Conventions

- Filenames use **kebab-case** derived from the artifact name.
  - Example: "Academic Research" becomes `academic-research.md` inside `_synapse/agents/`.
- Skills live in a subfolder named after the skill: `_synapse/skills/<kebab-name>/SKILL.md`.

## Permission Model

- **Always ask the user for permission** before creating or modifying any artifact file.
- State clearly what file you plan to create or modify, including its target path and a summary of contents.
- For **deletion**, ask for explicit extra confirmation.

## Artifact Types

- **Agent** — a persistent persona with its own instructions and tool restrictions. Spec + example: [agents.md](_synapse/skills/synapse-config/agents.md).
- **Skill** — a procedure, workflow, or reference the agent consults. Spec + example: [skills.md](_synapse/skills/synapse-config/skills.md).
- **MCP servers** — configured in `_synapse/.mcp.json`, standard Model Context Protocol server definitions.

## Setup

When the user is starting with Synapse or asks for custom writing styles, follow [setup.md](_synapse/skills/synapse-config/setup.md).

## Workflow for Assisting the User

1. **Propose**: Show the user the exact frontmatter and body you intend to write, at the correct path for the artifact type.
2. **Write**: Only after the user approves, write the file. Done when the file exists at the proposed path with the proposed content — never write on a proposal the user hasn't confirmed.
