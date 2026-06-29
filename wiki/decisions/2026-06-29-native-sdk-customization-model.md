# Re-base customization model onto native Agent SDK primitives

> Status: **functional decision agreed** (grill-me session, 2026-06-29). Scoped as sub-issues
> under [#13](https://github.com/NunoMotaRicardo/obsidian-claude-brain/issues/13).

## Context

The vault-local customization model (`_synapse/` folder with agents, prompts, skills, tools, and
triggers) was designed around the Copilot SDK. Each artifact type had a custom file format parsed
by `configLoader.ts` and mapped into Copilot SDK session options. With the
[Claude Agent SDK migration](2026-06-28-claude-agent-sdk-migration.md) complete at the engine
level, the customization layer still uses custom parsing and mapping — the artifacts aren't
"native" SDK primitives.

The question: should each customization type be re-based onto the SDK's own discovery and
management mechanisms, or should the plugin keep its custom loading layer?

## Decision

### Fully SDK-native

Every customization artifact must be an SDK-compliant file format that the SDK discovers and
manages directly. Custom formats are removed, not preserved alongside native ones. The only
exception is when going native would lose functionality the SDK cannot replicate.

### Per-artifact resolution

| Artifact (today) | Resolution | Rationale |
|---|---|---|
| `agents/*.agent.md` | **Native** — rename to `*.md`, SDK discovers from plugin `agents/` | SDK `AgentDefinition` covers all needed fields; custom parsing adds no value |
| `prompts/*.prompt.md` | **Merged into skills** — each prompt becomes a `<name>/SKILL.md` | SDK skills serve the same slash-command template role; eliminates a redundant concept |
| `skills/*/SKILL.md` | **Native** — SDK discovers from plugin `skills/` | Already the right format; just needed plugin registration |
| `tools/mcp.json` | **Native** — becomes `.mcp.json` at plugin root, SDK discovers | Drop `${input:id}` secret resolution; users configure secrets via env vars (standard SDK pattern) |
| `triggers/*.trigger.md` | **Deferred** — removed from this scope, revisited in [#14](https://github.com/NunoMotaRicardo/obsidian-claude-brain/issues/14) | SDK hooks ≠ cron/glob background tasks; no SDK primitive for starting autonomous AI conversations from external events |

### Folder layout

```
_synapse/                    ← registered as SDK local plugin
  agents/     *.md           ← SDK-discovered agents
  skills/     */SKILL.md     ← SDK-discovered skills (includes migrated prompts)
  .mcp.json                  ← SDK-discovered MCP servers
```

- **Folder name: `_synapse/`** — underscore prefix sorts it to the top of Obsidian's file
  explorer, visible and editable by the user. Hardcoded (no longer a configurable setting).
- **No `prompts/`, `triggers/`, or `tools/` folders.** Prompts are now skills. Triggers are
  deferred. MCP config is `.mcp.json` at the plugin root.

### Plugin registration

The `_synapse/` folder is registered as an SDK local plugin via `Options.plugins` on every
session/query:

```typescript
plugins: [{ type: 'local', path: '<vault>/_synapse/' }]
```

No persistent registration or explicit reload needed — the CLI spawns fresh per query and
re-discovers artifacts each time. After the self-improve feature writes a new skill or agent,
the next query picks it up automatically.

### Agent file format

SDK `AgentDefinition` fields only — no custom frontmatter:

- `description` — when to use this agent
- `prompt` (body) — agent instructions
- `model` — model alias (`sonnet`, `haiku`) or full ID
- `tools` — allowed tool names (omit = inherit all)
- `disallowedTools` — explicitly blocked tools
- `skills` — skill names to preload
- `mcpServers` — per-agent MCP server specs

### Skill toggling

Per-session skill filtering uses `Options.skills: string[]` (native SDK). The toolbar passes
the user's enabled-skill selection through this field.

### MCP server toggling

Dropped. All plugin-discovered MCP servers are always available. Users who don't want a server
remove it from `.mcp.json`.

### Toolbar population

A lightweight local scan of `_synapse/agents/` and `_synapse/skills/` reads folder names and
frontmatter descriptions for toolbar dropdown display. This is display-only — no config
building, no agent parsing. The SDK owns discovery and execution.

### Self-improve feature

- `configWriter.ts` slimmed to: `writeAgent`, `writeSkill`, `modifyArtifact`, `deleteArtifact`.
- All writers produce SDK-native formats (`.md` for agents, `SKILL.md` for skills).
- `writePrompt` and `writeTrigger` removed.
- `buildSelfImproveHint()` updated to mention only "agent" and "skill" as artifact types.

### configLoader.ts

Deleted entirely. `parseFrontmatter()` and `FM_RE` move to `configWriter.ts` (only consumer:
`modifyArtifact`). All load functions (`loadAgents`, `loadSkills`, `loadPrompts`, `loadTriggers`,
`loadMcpServers`, `loadMcpInputs`) are removed.

### Seed artifact

On first install, the plugin seeds `_synapse/skills/improve-synapse/SKILL.md` as a starter skill
— demonstrates the format and provides immediate self-improve functionality.

### No migration

No auto-migration of old `sidekick/` or `_sidekick/` artifacts. Users start from scratch with
the new `_synapse/` layout.

## Rationale

- **Why fully native, not hybrid:** the custom parsing layer (`configLoader.ts`) is the single
  largest piece of non-SDK code in the plugin. Every custom format is a maintenance surface that
  must track SDK changes. Going native eliminates ~300 lines of parsing, the `McpInputVariable`
  type, the secret-prompting flow, and the entire concept of "mapping" artifacts to SDK types.
- **Why merge prompts into skills:** prompts were slash-command templates that prepend text to
  the user's message. SDK skills serve exactly the same role — a directory with instructions
  invocable via `/name`. Keeping two concepts that do the same thing adds UI complexity (two
  dropdown menus), code complexity (two loaders, two writers), and user confusion.
- **Why defer triggers:** SDK hooks fire during active agent sessions for agent-initiated events
  (file changes the agent makes, tool use, permissions). Plugin triggers fire at any time in
  response to vault activity (user edits, cron schedules) and start autonomous AI conversations.
  These are fundamentally different event models. Triggers also overlap with the planned loop
  features ([#14](https://github.com/NunoMotaRicardo/obsidian-claude-brain/issues/14)), making
  the loop design the right place to reintroduce scheduled/event-driven background AI.
- **Why drop MCP secret resolution:** the `${input:id}` → modal → localStorage flow was a
  Copilot SDK pattern. The standard SDK approach is environment variables. Dropping it simplifies
  the MCP loading path and aligns with how every other Claude Code installation configures MCP
  servers.
- **Why `_synapse/` visible, not `.synapse/` hidden:** the customization model is built around
  user-editable markdown files. The self-improve feature creates artifacts the user should be
  able to see, read, and tweak in Obsidian's file explorer. Dot-prefix folders are hidden by
  Obsidian with no way to show them. The underscore prefix sorts the folder to the top without
  hiding it.
- **Why hardcode the folder name:** the `synapseFolder` setting added configuration surface for
  no real benefit. One canonical name, one fewer setting, simpler code.

## Scope / Non-goals

- **Not designing loop/trigger features** — deferred to [#14](https://github.com/NunoMotaRicardo/obsidian-claude-brain/issues/14).
- **Not migrating old vault artifacts** — clean break.
- **Not adding new SDK features** (hooks, commands, subagent delegation) — this re-base makes
  the existing feature set native; new capabilities are future work.

## Open Questions

- **SDK agent file discovery format** — verify that the SDK scans `agents/*.md` (not
  `.agent.md`) in local plugin directories, and confirm which frontmatter fields it parses.
  Spike during implementation.
- **Toolbar refresh timing** — the lightweight local scan for agent/skill names runs at plugin
  startup. If a user creates a new agent mid-session via self-improve, the toolbar won't show it
  until the next startup or manual refresh. May need a file-watcher or post-write refresh.

## Hand-off Notes for the Technical Planner

Functional intent to turn into `specs/` updates and GitHub issues:

1. **Register `_synapse/` as an SDK local plugin** — pass `plugins: [{type: 'local', path}]` in
   every session `Options`. Remove `skipMcpDiscovery` (MCP goes native too). Rename
   `tools/mcp.json` → `.mcp.json` at the plugin root.
2. **Delete `configLoader.ts`** — move `parseFrontmatter`/`FM_RE` to `configWriter.ts`. Remove
   all load functions. Remove the `synapseFolder` setting and its reload watcher. Remove
   `McpInputVariable` type and secret-prompting flow.
3. **Slim `configWriter.ts`** — remove `writePrompt`, `writeTrigger`. Update `writeAgent` to
   produce `.md` files (not `.agent.md`) with SDK-only frontmatter. Ensure `writeSkill` format
   is SDK-compatible.
4. **Remove trigger system** — delete `triggerScheduler.ts`, `tasks.ts`, trigger-related UI in
   `triggersPanel.ts`, trigger loading, trigger types. Remove "trigger" from the self-improve
   hint and from the AI customization guide.
5. **Update self-improve hint** — `buildSelfImproveHint()` mentions only "agent" and "skill".
6. **Update toolbar** — agent picker and skill toggles read from a lightweight local scan (names
   + descriptions). Skill toggling passes `Options.skills: string[]`. Remove MCP server
   toggling. Remove the `prompts/` dropdown.
7. **Rename `agents/*.agent.md` → `agents/*.md`** in any seed/default artifacts.
8. **Seed `improve-synapse`** — write `_synapse/skills/improve-synapse/SKILL.md` on first
   install (if not present).
9. **Hardcode folder name** — replace `settings.synapseFolder` with `'_synapse'` constant.
   Remove the setting from the settings tab.
10. **Update specs** — rewrite `specs/config-loader.md` (now covers config-writer + plugin
    registration), update `specs/bots-triggers.md` (triggers section removed),
    `specs/chat-view.md` (self-improve hint, toolbar changes), `specs/copilot-service.md`
    (plugin registration in Options).
11. **Update `wiki/ai-customization-guide.md`** — rewrite to reflect the native SDK model
    (`_synapse/` layout, no prompts/triggers, SDK-native formats).

## Related

- [`2026-06-28-claude-agent-sdk-migration.md`](2026-06-28-claude-agent-sdk-migration.md) — the
  parent migration decision that identified this re-base as the capability-expansion target.
- [`../ai-customization-guide.md`](../ai-customization-guide.md) — the guide that must be
  rewritten to reflect the new native model.
- [#13](https://github.com/NunoMotaRicardo/obsidian-claude-brain/issues/13) — the tracking
  issue for this work.
- [#14](https://github.com/NunoMotaRicardo/obsidian-claude-brain/issues/14) — backlog item for
  loop features, where triggers will be revisited.
