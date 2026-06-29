# config-loader

Source: `src/configLoader.ts`. Reads the vault-side config folder (default `sidekick/`,
this user's vault uses `_sidekick/`) and turns files into runtime config.

## Inputs

```
<folder>/
  agents/    *.agent.md     → CustomAgentConfig-ish {name, description, model, tools, skills} + body = system prompt
  skills/    <name>/SKILL.md → skillDirectories entries; toggleable per session
  tools/     mcp.json        → Record<string, MCPServerConfig> (+ "inputs" for ${input:id} secrets)
  prompts/   *.prompt.md     → slash-command templates {agent?, description?} + body
  triggers/  *.trigger.md    → {name?, agent?, cron?, glob?, enabled?} + body = prompt
```

## Rules

- Agent `tools`/`skills` frontmatter: omitted = all enabled; present-but-empty = all disabled;
  list = only those.
- Agent `model` frontmatter binds the agent definition to a specific Claude model ID or local backend reference. `toCustomAgentConfig` maps this field to SDK `AgentDefinition.model`.
- `mcp.json` accepts `servers` or `mcpServers` top-level key; `${input:id}` placeholders are
  resolved from stored MCP input values, prompting for missing ones at load time.
- Reload button in the toolbar re-parses everything; malformed files log and are skipped,
  never crash the panel.
- SDK 1.0 type note: server entries map to `MCPStdioServerConfig` (`command`/`args`/`env`) or
  `MCPHTTPServerConfig` (`type: "http" | "sse"`, `url`, `headers`).

## Config writer (`src/configWriter.ts`) — implemented

Write counterparts for the loader functions above. Used by the self-improve feature to
programmatically create, modify, and delete vault-local customization artifacts.

### Functions

| Function | Creates | File pattern |
|---|---|---|
| `writeAgent(app, folder, config)` | `*.agent.md` | `<folder>/<kebab-name>.agent.md` |
| `writePrompt(app, folder, config)` | `*.prompt.md` | `<folder>/<kebab-name>.prompt.md` |
| `writeSkill(app, folder, config)` | `SKILL.md` in subfolder | `<folder>/<kebab-name>/SKILL.md` |
| `writeTrigger(app, folder, config)` | `*.trigger.md` | `<folder>/<kebab-name>.trigger.md` |
| `modifyArtifact(app, filePath, updates)` | — | Patches frontmatter/body in-place |
| `deleteArtifact(app, filePath)` | — | Moves to Obsidian trash |
| `ensureFolder(app, path)` | Folder | Creates intermediates |

### Rules

- Filenames are kebab-case derived from the artifact name.
- Frontmatter serialization round-trips through `parseFrontmatter` (exported from configLoader).
- Strings containing colons, quotes, or newlines are double-quoted with `\"` escaping.
- `modifyArtifact` reuses `parseFrontmatter` from configLoader (no duplication).
- Never writes to `mcp.json` — no function for MCP config mutation.
- Types: reuses `AgentConfig`, `PromptConfig`, `TriggerConfig` from `src/types.ts`;
  adds `SkillWriteConfig` for skill creation.
