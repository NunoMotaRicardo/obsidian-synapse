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
- `mcp.json` accepts `servers` or `mcpServers` top-level key; `${input:id}` placeholders are
  resolved from stored MCP input values, prompting for missing ones at load time.
- Reload button in the toolbar re-parses everything; malformed files log and are skipped,
  never crash the panel.
- SDK 1.0 type note: server entries map to `MCPStdioServerConfig` (`command`/`args`/`env`) or
  `MCPHTTPServerConfig` (`type: "http" | "sse"`, `url`, `headers`).
