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
  .mcp.json                  SDK-discovered MCP servers
```

No `prompts/` or `tools/` folders. Prompts merged into skills; MCP config is `.mcp.json` at
plugin root.

A `triggers/` folder from before issue #188 may still exist in a vault's `_synapse/` — the plugin
no longer reads it, but does not delete or otherwise touch it; it is inert, user-owned content.

## Toolbar population (display-only scan)

A lightweight scan of `_synapse/agents/` and `_synapse/skills/` reads folder/file names and
frontmatter descriptions for toolbar dropdown display. This is display-only — the SDK owns
discovery and execution. Implemented as simple directory listing + frontmatter parse, not a full
config load.

## Config writer (`src/configWriter.ts`)

Write operations for the self-improve feature. All output is SDK-native format.

### Functions

| Function | Creates | File pattern |
|---|---|---|
| `scanAgents(app, folder)` | — | Reads `_synapse/agents/*.md` → `AgentConfig[]` |
| `scanSkills(app, folder)` | — | Reads `_synapse/skills/*/SKILL.md` → `SkillInfo[]` |
| `writeAgent(app, folder, config)` | `*.md` | `_synapse/agents/<kebab-name>.md` |
| `writeSkill(app, folder, config)` | `SKILL.md` in subfolder | `_synapse/skills/<kebab-name>/SKILL.md` |
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

### Frontmatter value escaping (write ↔ read must be inverses)

`serializeFmField` quotes a scalar value when it contains a colon, a double quote, a newline,
or has leading/trailing whitespace (`needsQuotes = /[:"\n]/.test(str) || str !== str.trim()`).
Only quoted values are escaped: `\` → `\\` and `"` → `\"`. Unquoted values (the common case —
e.g. a Windows path with no colon) are written verbatim and must never be touched by the
un-escape step.

`parseFrontmatter` strips the surrounding quotes and, for double-quoted values only, un-escapes
`\\` and `\"` back to `\` and `"` in a **single left-to-right regex pass**
(`/\\(\\|")/g`), not two sequential `.replace()` calls. A two-step un-escape can mis-pair a
literal backslash that sits immediately before an escaped quote; the single alternation-regex
pass consumes each two-character escape token (`\\` or `\"`) atomically, left to right, which is
the correct inverse of how `serializeFmField` produced it.

Write and read are round-trip inverses for every string value, including one that already went
through a prior `writeAgent`/`modifyArtifact` cycle — `modifyArtifact` reads (un-escapes),
merges, and re-serializes (re-escapes), so an un-escape bug compounds (doubles) on every cycle
rather than staying constant. See issue #161.

**Existing on-disk artifacts are not migrated.** A doubled backslash already written by the old
(unpaired) code path is indistinguishable from a legitimate single escaped backslash — there is
no reliable way to tell "this was corrupted by the old bug" from "the user's actual value
contains `\\`". Attempting to "repair" old files on read would silently corrupt values that were
always correct. Only newly written/modified artifacts benefit from the fix; pre-existing
corrupted values must be fixed by the user re-entering them.

## Vault structure scanner

`scanVaultStructure(app, synapseFolder)` scans top-level vault folders (name + child count),
excluding `_synapse`, `.obsidian`, `.trash`, and dot-prefixed folders. Used by
`buildVaultContextBlock()` in `sessionConfig.ts` for the system prompt.

## Self-improve hint

`buildSelfImproveHint(agentName)` in `sessionConfig.ts` teaches agents to recognize
customization intent. Mentions "agent" and "skill" as artifact types.
Skipped when the user is already using the `improve-synapse` skill.

## First-run seeding

On plugin startup, if `_synapse/skills/improve-synapse/SKILL.md` does not exist, the plugin
seeds it as a starter skill demonstrating the format.
