# config-writer

Source: `src/configWriter.ts`. Scan utilities for toolbar display, first-run seeding, and
tool-approval persistence. The Claude Agent SDK
discovers agents, skills, and MCP servers natively from the
`_synapse/` plugin directory.

**The live self-improve write path is the CLI agent's own `Write`/`Edit` tools operating on
`_synapse/`** — an agent asked to propose an artifact writes it directly (guided by the
self-improve hint, see the bottom of this spec). This module does not sit between the agent and
the vault. Its live write paths are `installStarterKit` (copies bundled Markdown verbatim)
and `persistToolApprovalRules`. `writeSkill` is an exported create-only helper with no current
production caller; it is exercised by unit tests.

## Plugin registration

The `_synapse/` vault folder is registered as an SDK local plugin on every query/session:

```typescript
plugins: [{ type: 'local', path: '<vaultBasePath>/_synapse/' }]
```

The SDK discovers:
- `_synapse/agents/*.md` → SDK `AgentDefinition` subagents
- `_synapse/skills/*/SKILL.md` → SDK skills (invocable via `/name`)
- `_synapse/.mcp.json` → SDK MCP server configs

No `skipMcpDiscovery` is set by the plugin. MCP discovery is SDK-native; the display scans
use a lightweight YAML-like frontmatter parser, not a complete YAML implementation.
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

Starter-kit installation copies the text in `STARTER_FILES`; approval persistence writes JSON.
The separate `writeSkill` helper serializes frontmatter and creates a new skill file.

### Functions

| Function | Creates | File pattern |
|---|---|---|
| `scanAgents(app, folder)` | — | Reads `_synapse/agents/*.md` → `AgentConfig[]` |
| `scanSkills(app, folder)` | — | Reads `_synapse/skills/*/SKILL.md` → `SkillInfo[]` |
| `writeSkill(app, folder, config)` | `SKILL.md` in subfolder | `_synapse/skills/<kebab-name>/SKILL.md` |
| `ensureFolder(app, path)` | Folder | Creates intermediates |
| `persistToolApprovalRules(app, ruleStrings)` | `settings.json` (if absent) | `_synapse/settings.json`'s `permissions.allow` |

### Rules

- Display scans accept immediate `.md` files, including `.agent.md` (the bundled Writer uses
  this suffix). An explicit `name` takes precedence; otherwise `.agent` is removed from the basename.
- Agent scans expose `name`, `description`, `model`, `tools`, `skills`, trimmed body instructions,
  and `filePath`. Tools/skills accept comma-separated scalars or indented lists; absent fields
  become `undefined`, explicitly empty fields become `[]`. Other frontmatter fields are not
  mapped into `AgentConfig`; SDK discovery remains independent of this display scan.
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

The escaping rules are inverse for the supported single-line scalar values written by
`writeSkill` via `serializeFmField`/`buildMarkdown`. Embedded newlines are quoted but remain
literal newlines; the line-oriented parser does not provide general multiline YAML round trips.
Round-trip unit tests exercise single-line descriptions containing colons, quotes,
backslashes, and whitespace padding. `writeSkill` serializes its supplied in-memory configuration; starter-kit files bypass this serializer.

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

This function is never invoked at all for an ask the CLI marks `suppressAlwaysAllowRule`
(issue #268) — the modal hides **Always allow** for that ask entirely, so `persistRules` from
`ToolApprovalModal`'s promise is always empty in that case. See `chat-view.md`'s "Risk hints
suppress Always allow and default-approve".

- `ruleStrings` are already in the CLI's `Settings.permissions.allow` rule-string syntax
  (`toolName` or `toolName(ruleContent)`) — produced by `permissionRuleToString()`/
  `extractAllowRuleStrings()` in `agentService.ts`, never re-derived here.
- No-op (returns immediately, writes nothing) when `ruleStrings` is empty.
- Serializes writes to `_synapse/settings.json` through `lockManager`, same as every other writer
  in this module.
- Creates `_synapse/settings.json` (and `_synapse/` itself) if absent, otherwise reads it via
  `vault.read`, parses as JSON, and writes back **every top-level key untouched** except
  `permissions.allow`, which is unioned (deduplicated, never clobbered) with `ruleStrings`.
- Uses the Vault API (not `node:fs` or `vault.adapter`): `getAbstractFileByPath()` determines
  whether the file exists before `vault.read`, `vault.create`, or `vault.modify`. `_synapse/settings.json`
  is read by `AgentService.loadVaultSettings()` (`agent-service.md`)
  via `node:fs`, cached by the file's mtime — a `vault.create`/`vault.modify` write here changes
  that mtime, so the next query picks up the change with no separate invalidation.
- Invalid JSON throws (surfaced by the caller as a `Notice`) rather than being
  silently overwritten; the caller's in-memory, conversation-scoped grant already returned to the
  SDK is unaffected by a persistence failure.
- Valid JSON that is not an object is treated as an empty settings object; malformed
  `permissions` containers are replaced and non-string allow entries are filtered out.
- No removal UI — removing a persisted grant means hand-editing `_synapse/settings.json`'s
  `permissions.allow` list; documented in `wiki/Customization.md`.

## Vault structure scanner

`scanVaultStructure(app)` returns alphabetically sorted `{name, fileCount}` entries for top-level
folders. `fileCount` is the immediate child count (including folders), not a recursive note count.
It excludes `_synapse`, `app.vault.configDir`, `.trash`, and dot-prefixed folders.
`buildVaultContextBlock()` in `sessionConfig.ts` uses only the names and sends the resulting
context in the per-turn user message, not the system prompt.

## Self-improve hint

`buildSelfImproveHint()` in `sessionConfig.ts` teaches agents to recognize customization intent.
Mentions "agent" and "skill" as artifact types and names the `synapse-config` skill. Session-stable and takes no arguments — the
volatile "Current agent" line is delivered per-turn by `buildCurrentAgentLine(agentName)`
instead, so this static hint doesn't invalidate the cached system-prompt prefix when the selected
agent changes.

## Starter kit

`installStarterKit(app, synapseFolder?)` writes the plugin's starter kit into `_synapse/` and
returns the vault paths it created. The kit's content lives as plain Markdown under
`src/starter/` (mirroring the paths below `_synapse/`) and is bundled into `main.js` as text by
esbuild's `.md` loader (`vitest.config.ts` mirrors that loader for tests); `src/starterKit.ts`
lists the files in `STARTER_FILES`:

- `agents/writer.agent.md` — **Writer** agent (structure of essays, documents, speeches, articles).
- `skills/synapse-config/` — authoring agents, skills, and MCP servers; `setup.md` builds
  custom writing styles from the user's own documents.
- `skills/obsidian/` — Obsidian Flavored Markdown, Bases, and the `obsidian` CLI.
- `skills/think/` — one-question-at-a-time interview before producing output.
- `skills/writing-style/` — voice selection (custom styles in `styles/` or built-in defaults)
  and AI-tell removal.

Never overwrites: an existing file is skipped, so re-running only restores missing files.
Called from two places:

- **First run** — `main.ts` `onload()` registers an `onLayoutReady` callback (so the vault index
  is loaded) that installs the kit only when the `_synapse/` folder does not exist.
- **Settings → Capabilities → Initialize** — installs any missing starter files.

