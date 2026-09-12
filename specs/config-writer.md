# config-writer

Source: `src/configWriter.ts`. Scan utilities for toolbar display, first-run seeding, and
tool-approval persistence. The Claude Agent SDK
discovers agents, skills, and MCP servers natively from the
`_synapse/` plugin directory.

**The live self-improve write path is the CLI agent's own `Write`/`Edit` tools operating on
`_synapse/`** — an agent asked to propose an artifact writes it directly (guided by the
self-improve hint, see the bottom of this spec). This module does not sit between the agent and
the vault. Its write surface is `writeSkill` (first-run seeding) and
`persistToolApprovalRules` (issue #197), both with live in-tree callers.

## Plugin registration

The `_synapse/` vault folder is registered as an SDK local plugin on every query/session:

```typescript
plugins: [{ type: 'local', path: '<vaultBasePath>/_synapse/' }]
```

The SDK discovers:
- `_synapse/agents/*.md` → SDK `AgentDefinition` subagents
- `_synapse/skills/*/SKILL.md` → SDK skills (invocable via `/name`)
- `_synapse/.mcp.json` → SDK MCP server configs

No `skipMcpDiscovery` — MCP goes fully native. No custom parsing.
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

A `triggers/` folder may still exist in a vault's `_synapse/` — the plugin no longer reads it,
but does not delete or otherwise touch it; it is inert, user-owned content.

## Toolbar population (display-only scan)

A lightweight scan of `_synapse/agents/` and `_synapse/skills/` reads folder/file names and
frontmatter descriptions for toolbar dropdown display. This is display-only — the SDK owns
discovery and execution. Implemented as simple directory listing + frontmatter parse, not a full
config load.

## Config writer (`src/configWriter.ts`)

Writes for the module's two live write paths (first-run seeding and tool-approval persistence)
plus the shared serialization helpers they rest on. All output is
SDK-native format.

### Functions

| Function | Creates | File pattern |
|---|---|---|
| `scanAgents(app, folder)` | — | Reads `_synapse/agents/*.md` → `AgentConfig[]` |
| `scanSkills(app, folder)` | — | Reads `_synapse/skills/*/SKILL.md` → `SkillInfo[]` |
| `writeSkill(app, folder, config)` | `SKILL.md` in subfolder | `_synapse/skills/<kebab-name>/SKILL.md` |
| `ensureFolder(app, path)` | Folder | Creates intermediates |
| `persistToolApprovalRules(app, ruleStrings)` | `settings.json` (if absent) | `_synapse/settings.json`'s `permissions.allow` |

### Rules

- Agent files use `.md` extension (not `.agent.md`) — SDK convention.
- Agent frontmatter: SDK `AgentDefinition` fields only (`description`, `model`, `tools`,
  `skills`, `disallowedTools`, `mcpServers`). No custom fields.
- `parseFrontmatter()` and `FM_RE` live in this module; `parseFrontmatter` is the reader behind
  the scans (`scanAgents`, `scanSkills`).
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

Write and read are round-trip inverses for every string value the live writer (`writeSkill`, via
`serializeFmField`/`buildMarkdown`) produces — a skill's `description` field exercises the same
quoting/escaping paths (colons, quotes, backslashes, whitespace padding) the round-trip unit
tests assert. Every write starts from an in-memory value rather than a re-serialized read, so
an un-escape bug could not compound across cycles.

**Existing on-disk artifacts are not migrated.** A doubled backslash already written by a prior
code path is indistinguishable from a legitimate single escaped backslash — there is no reliable
way to tell corrupted values from correct ones. Attempting to "repair" old files on read would
silently corrupt values that were always correct. Only newly written/modified artifacts benefit
from the current implementation; pre-existing corrupted values must be fixed by the user
re-entering them.

## Tool-approval persistence

`persistToolApprovalRules(app, ruleStrings)` is the one place `ToolApprovalModal`'s **Always
allow** action writes to disk (the modal itself never touches the filesystem — it only returns
which rule strings to persist; see `chat-view.md`'s "A deliberate, permanent grant is back").

- `ruleStrings` are already in the CLI's `Settings.permissions.allow` rule-string syntax
  (`toolName` or `toolName(ruleContent)`) — produced by `permissionRuleToString()`/
  `extractAllowRuleStrings()` in `agentService.ts`, never re-derived here.
- No-op (returns immediately, writes nothing) when `ruleStrings` is empty.
- Serializes writes to `_synapse/settings.json` through `lockManager`, same as every other writer
  in this module.
- Creates `_synapse/settings.json` (and `_synapse/` itself) if absent, otherwise reads it via
  `vault.read`, parses as JSON, and writes back **every top-level key untouched** except
  `permissions.allow`, which is unioned (deduplicated, never clobbered) with `ruleStrings`.
- Uses the `vault`/`vault.adapter.exists` API (not `node:fs`), matching every other writer in this
  file. `_synapse/settings.json` is read by `AgentService.loadVaultSettings()` (`agent-service.md`)
  via `node:fs`, cached by the file's mtime — a `vault.create`/`vault.modify` write here changes
  that mtime, so the next query picks up the change with no separate invalidation.
- A malformed existing file throws (surfaced by the caller as a `Notice`) rather than being
  silently overwritten; the caller's in-memory, conversation-scoped grant already returned to the
  SDK is unaffected by a persistence failure.
- No removal UI — removing a persisted grant means hand-editing `_synapse/settings.json`'s
  `permissions.allow` list; documented in `wiki/Customization.md`.

## Vault structure scanner

`scanVaultStructure(app)` scans top-level vault folders (name only, no counts), excluding
`_synapse`, `.obsidian`, `.trash`, and dot-prefixed folders. Used by `buildVaultContextBlock()`
in `sessionConfig.ts` for the system prompt.

## Self-improve hint

`buildSelfImproveHint()` in `sessionConfig.ts` teaches agents to recognize customization intent.
Mentions "agent" and "skill" as artifact types. Session-stable and takes no arguments — the
volatile "Current agent" line is delivered per-turn by `buildCurrentAgentLine(agentName)`
instead, so this static hint doesn't invalidate the cached system-prompt prefix when the selected
agent changes.

## First-run seeding

On plugin startup, if `_synapse/skills/improve-synapse/SKILL.md` does not exist, the plugin
seeds it as a starter skill demonstrating the format.

