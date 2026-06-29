# config-writer (was: config-loader)

Source: `src/configWriter.ts`. Write-side utilities for the self-improve feature and first-run
seeding. The read/load side (`configLoader.ts`) has been deleted — the Claude Agent SDK discovers
agents, skills, and MCP servers natively from the `_synapse/` plugin directory.

## Plugin registration

The `_synapse/` vault folder is registered as an SDK local plugin on every query/session:

```typescript
plugins: [{ type: 'local', path: '<vaultBasePath>/_synapse/' }]
```

The SDK discovers:
- `_synapse/agents/*.md` → SDK `AgentDefinition` subagents
- `_synapse/skills/*/SKILL.md` → SDK skills (invocable via `/name`)
- `_synapse/.mcp.json` → SDK MCP server configs

No `skipMcpDiscovery` — MCP goes fully native. No custom parsing, no `configLoader.ts`.
The CLI spawns fresh per query, re-discovers artifacts each time — no explicit reload needed.

## Folder layout

```
_synapse/                   (hardcoded — not a setting)
  agents/    *.md            SDK-discovered agents (AgentDefinition fields only)
  skills/    */SKILL.md      SDK-discovered skills (includes merged prompts)
  triggers/  *.md            Trigger definitions (event- or schedule-based)
  .mcp.json                  SDK-discovered MCP servers
```

No `prompts/` or `tools/` folders. Prompts merged into skills; MCP config is `.mcp.json` at
plugin root.

## Toolbar population (display-only scan)

A lightweight scan of `_synapse/agents/`, `_synapse/skills/`, and `_synapse/triggers/` reads
folder/file names and frontmatter descriptions for toolbar dropdown display. This is
display-only — the SDK owns discovery and execution. Implemented as simple directory listing +
frontmatter parse, not a full config load.

## Config writer (`src/configWriter.ts`)

Write operations for the self-improve feature. All output is SDK-native format.

### Functions

| Function | Creates | File pattern |
|---|---|---|
| `scanAgents(app, folder)` | — | Reads `_synapse/agents/*.md` → `AgentConfig[]` |
| `scanSkills(app, folder)` | — | Reads `_synapse/skills/*/SKILL.md` → `SkillInfo[]` |
| `scanTriggers(app, folder)` | — | Reads `_synapse/triggers/*.md` → `TriggerConfig[]` |
| `writeAgent(app, folder, config)` | `*.md` | `_synapse/agents/<kebab-name>.md` |
| `writeSkill(app, folder, config)` | `SKILL.md` in subfolder | `_synapse/skills/<kebab-name>/SKILL.md` |
| `writeTrigger(app, folder, config)` | `*.md` | `_synapse/triggers/<kebab-name>.md` |
| `modifyArtifact(app, filePath, updates)` | — | Patches frontmatter/body in-place |
| `deleteArtifact(app, filePath)` | — | Moves to Obsidian trash |
| `ensureFolder(app, path)` | Folder | Creates intermediates |

### Rules

- Agent files use `.md` extension (not `.agent.md`) — SDK convention.
- Agent frontmatter: SDK `AgentDefinition` fields only (`description`, `model`, `tools`,
  `skills`, `disallowedTools`, `mcpServers`). No custom fields.
- `parseFrontmatter()` and `FM_RE` live in this module (moved from deleted `configLoader.ts`).
- `modifyArtifact` uses `parseFrontmatter` for in-place patching.
- No MCP config mutation — `.mcp.json` is user-edited.

## Vault structure scanner

`scanVaultStructure(app, synapseFolder)` scans top-level vault folders (name + child count),
excluding `_synapse`, `.obsidian`, `.trash`, and dot-prefixed folders. Used by
`buildVaultContextBlock()` in `sessionConfig.ts` for the system prompt.

## Self-improve hint

`buildSelfImproveHint(agentName)` in `sessionConfig.ts` teaches agents to recognize
customization intent. Mentions "agent", "skill", and "trigger" as artifact types.
Skipped when the user is already using the `improve-synapse` skill.

## First-run seeding

On plugin startup, if `_synapse/skills/improve-synapse/SKILL.md` does not exist, the plugin
seeds it as a starter skill demonstrating the format.
