---
name: obsidian
description: Obsidian vault work — writing notes in Obsidian Flavored Markdown (wikilinks, embeds, callouts, frontmatter, tags), building Bases (.base files with filters, formulas, views), or driving a running Obsidian through the `obsidian` CLI (vault operations, plugin/theme debugging).
---

# Obsidian

Three areas share this skill. Load only the reference files the task touches, before writing anything.

| Task touches | Load |
|---|---|
| A `.md` note — links, embeds, callouts, properties, tags, math, diagrams | [markdown.md](_synapse/skills/obsidian/markdown.md) |
| A `.base` file or an embedded base view | [bases.md](_synapse/skills/obsidian/bases.md); add [bases-functions.md](_synapse/skills/obsidian/bases-functions.md) for any function not listed in bases.md |
| Reading or changing the vault through a running Obsidian, or plugin/theme development | [cli.md](_synapse/skills/obsidian/cli.md) |

Areas combine: a note embedding a base needs markdown.md + bases.md; creating a note via CLI with callouts in its content needs cli.md + markdown.md.

## Shared rules

- **Links**: `[[wikilinks]]` for anything inside the vault (Obsidian tracks renames), `[text](url)` for external URLs only.
- **YAML** (frontmatter and `.base` files): quote any string containing `: { } [ ] , & * # ? | - < > = ! % @` or a backtick. Wrap expressions that contain double quotes in single quotes: `'if(done, "Yes", "No")'`.
- **One property namespace**: a frontmatter key `status` is `status` (or `note.status`) inside a Base.

## Workflow

1. **Route** — pick files from the table. Done when every area the task touches has its file loaded.
2. **Write** — follow the loaded reference.
3. **Checklist** — run the checklist at the end of each loaded file. Done when every item passes.
4. **Confirm** — if Obsidian is running, verify with the CLI (`obsidian read file=...`, `obsidian dev:errors`); otherwise tell the user which view to open to check rendering.
