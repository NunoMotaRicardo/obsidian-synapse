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

## Config writer (implemented)

Source: `src/configWriter.ts`. Write counterparts to the reader functions above.

### Functions

- `writeAgent(app, folder, config)` — creates `<kebab-name>.agent.md` with frontmatter + body
- `writePrompt(app, folder, config)` — creates `<kebab-name>.prompt.md`
- `writeSkill(app, folder, config)` — creates `<kebab-name>/SKILL.md`, creating subdirectory
- `writeTrigger(app, folder, config)` — creates `<kebab-name>.trigger.md`
- `modifyArtifact(app, filePath, updates)` — patches frontmatter/body of an existing artifact
- `deleteArtifact(app, filePath)` — deletes via `vault.trash` (Obsidian-safe)
- `ensureFolder(app, path)` — creates missing intermediate directories
- `toKebabCase(name)` — derives kebab-case filename slug from artifact name

### Rules

- Frontmatter serialization is compatible with `configLoader.parseFrontmatter` (simple
  line-by-line format, not full YAML).
- Scalar values: `key: value`; lists: `    - item` (4-space indent); strings with colons are quoted.
- Never writes to `mcp.json`.
- Types: reuses `AgentConfig`, `PromptConfig`, `TriggerConfig` from `src/types.ts`;
  adds `SkillWriteConfig` for skill creation.
