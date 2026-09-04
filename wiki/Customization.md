# Synapse: AI Customization Guide

This guide explains the **vault-local customization model** of the Synapse Obsidian plugin.
Synapse reads your customization artifacts from a `_synapse/` folder in your vault and passes
them to the Claude Agent SDK as a native plugin — so your agents, skills, and MCP tools are
first-class SDK primitives, not a custom format layered on top.

> This guide reflects the **Claude Agent SDK** codebase (post June 2026 migration). For the
> history of the migration and the decisions behind it, see:
> [`.docs/decisions/2026-06-28-claude-agent-sdk-migration.md`](../.docs/decisions/2026-06-28-claude-agent-sdk-migration.md)
> and [`.docs/decisions/2026-06-29-native-sdk-customization-model.md`](../.docs/decisions/2026-06-29-native-sdk-customization-model.md).

---

## 1. The `_synapse/` folder layout

Synapse reads from a single hardcoded folder in your vault:

```text
_synapse/                 ← registered as an SDK local plugin on every session
  agents/
    *.md                  ← agent definitions (SDK AgentDefinition format)
  skills/
    <name>/
      SKILL.md            ← skill instructions (invocable via /name)
      ...optional resources...
  triggers/
    *.md                  ← trigger definitions (event- or schedule-based)
  .mcp.json               ← MCP server configs (SDK-native format)
```

The underscore prefix keeps `_synapse/` sorted at the top of Obsidian's file explorer and
visible by default (dot-prefix folders are hidden by Obsidian with no way to show them).

Everything in this folder is **user-editable markdown** — Obsidian's own editor is your
configuration UI.

---

## 2. Agents (`_synapse/agents/*.md`)

An agent definition is a `.md` file. The frontmatter sets the SDK `AgentDefinition` fields;
the body is the agent's system prompt.

### Format

```markdown
---
description: When to use this agent — shown in the toolbar picker
model: sonnet          # optional: model alias or full model ID
tools:                 # optional: tool allowlist (omit = all tools)
  - read_file
  - write_file
disallowedTools:       # optional: explicitly blocked tools
  - bash
skills:                # optional: skill names to preload
  - literature-synthesis
mcpServers:            # optional: per-agent MCP server overrides
  brave-search:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-brave-search"]
    env:
      BRAVE_API_KEY: "sk-..."
---
You are a knowledge synthesis specialist. Your job is to...
```

### Shipped default agents

When you click **Initialize** in Settings → Capabilities, Synapse seeds five default agents:

| File | Role |
|---|---|
| `general.md` | General-purpose assistant — default for chat, inline, search |
| `vision.md` | Vision-capable assistant — default for image/diagram analysis |
| `zettelkasten.md` | Atomic notes and dense cross-linking methodology |
| `para.md` | Projects, Areas, Resources, Archives methodology |
| `lyt.md` | Linking Your Thinking / Maps of Content methodology |

### Feature → Agent map

In **Settings → Feature Map & Agents**, you can map each plugin feature to a named agent:

| Feature | Default agent | What it does |
|---|---|---|
| `chat` | General | Main chat panel sessions |
| `inline` | General | Editor context-menu text actions |
| `search` | General | AI vault search |
| `telegram` | General | Telegram bot sessions |
| `vision` | Vision | Image extraction, vision actions |

You can remap any feature to a different agent and bind a specific model to each agent,
including a local model (e.g. `qwen3:8b` via Ollama).

### Self-improve: creating agents from chat

If you tell Synapse what kind of assistant behavior you want, it will offer to create or
modify an agent for you. Example:

> "Act more like a research synthesizer — focus on contrasting sources and flagging gaps"
> → Synapse offers to update or create a `research.md` agent in `_synapse/agents/`

After writing the agent file, the next query automatically picks it up — no reload needed.

---

## 3. Skills (`_synapse/skills/<name>/SKILL.md`)

A skill is a directory with a `SKILL.md` file. It gives the active agent a reusable set of
instructions, optionally bundled with resources (examples, reference docs, templates).

### Format

```markdown
---
name: literature-synthesis
description: Synthesize academic and web sources into structured notes
---
When synthesizing sources:
1. Identify the main claim and evidence for each source
2. Flag contradictions or gaps across sources
3. Structure the output as a Zettelkasten-compatible note
...
```

### Invocation

Skills appear in the toolbar's skill selector. Enable them per session. The SDK passes enabled
skill names via `Options.skills: string[]`; the CLI loads the matching `SKILL.md` and prepends
its instructions to the agent's context.

You can also invoke skills directly in chat with `/name`.

### Self-improve: creating skills from chat

> "Always use the Harvard citation format in research notes"
> → Synapse offers to create a `harvard-citations` skill

---

## 4. Triggers (`_synapse/triggers/*.md`)

Triggers automate vault operations. Each trigger is a markdown file with frontmatter metadata
and a prompt body. They fire either in response to vault events or on a cron schedule.

### Format

```markdown
---
name: auto-tag-inbox
description: Automatically tag new notes dropped into the inbox
event: file-created       # or: schedule: "0 9 * * *"
path: inbox/**            # optional glob filter
model: qwen3:8b           # optional: local model for cheap one-shot
agent: General            # optional: agent to use
write: frontmatter        # false (report) | true (replace) | frontmatter (merge YAML)
toolApproval: allow       # optional: let this trigger use tools without asking
enabled: true
---
Read the content of {{file}} and return YAML tags suitable for its frontmatter.
```

### Event types

| Event | Fires when |
|---|---|
| `file-created` | A new file is created |
| `file-modified` | An existing file is saved with changes |
| `file-deleted` | A file is deleted or trashed |
| `file-renamed` | A file is moved or renamed |

### Schedule format

Standard five-field cron expressions: `minute hour day-of-month month day-of-week`.

Examples:
- `0 9 * * *` — daily at 9:00 AM
- `0 8 * * 1` — every Monday at 8:00 AM

### Write modes

| `write` value | Output |
|---|---|
| `false` (default) | Appends result to `_synapse/reports/<name>-YYYY-MM-DD.md` |
| `true` | Replaces the triggering file's entire content with the model response |
| `'frontmatter'` | Parses response as YAML, merges keys into existing frontmatter |

### Tool approval

Triggers run unattended, so there is nobody to answer an approval prompt. The **Tools approval**
setting therefore means something different for them than it does for editor actions:

| Setting | Effect on a trigger |
|---|---|
| **Allow (auto-approve)** | Tool calls run without asking |
| **Ask (require approval)** (default) | Tool calls are **denied**, and each denial is recorded in the trigger's report |

Read-only work is unaffected either way — the model can still read the files it needs. Only tools
that would normally prompt (writing or editing a file, running a command) are denied.

Add `toolApproval: allow` to one trigger's frontmatter to grant just that trigger tool access
without loosening the global setting. There is no override in the other direction: a trigger
cannot force approval prompts when the global setting is already **Allow (auto-approve)**.

### Model routing

If `model` points to a Claude alias (or is omitted), the trigger runs as a full Claude session
via `AgentService.inlineChat()`. If `model` points to a local model, it runs as a one-shot
`executeLocalProviderQuery()` call, with built-in vault tools and any configured MCP servers
available for tool calling.

### Built-in vault tools (available to local models in triggers)

| Tool | Description |
|---|---|
| `read_note` | Read a note's content by path |
| `list_notes` | List notes in a folder |
| `search_notes` | Search notes by query |

### Self-improve: creating triggers from chat

> "Remind me every Monday to review my weekly project notes"
> → Synapse offers to create a `weekly-review` trigger in `_synapse/triggers/`

---

## 5. MCP servers (`_synapse/.mcp.json`)

Configures MCP servers that the Claude Agent SDK discovers natively for Claude sessions,
and that the MCP bridge spawns for local-model trigger sessions.

### Format

```jsonc
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "sk-..."
      }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

Secrets go in the `env` block as environment variables — the standard SDK pattern.
No UI prompt-based secret resolution.

All configured MCP servers are always available; remove a server from the file to disable it.

---

## 6. How the SDK discovers your customizations

On every chat session or query, Synapse passes `_synapse/` to the Claude Agent SDK as a
**local plugin**:

```typescript
plugins: [{ type: 'local', path: '<vaultRoot>/_synapse/' }]
```

The Claude CLI spawns fresh per query and re-discovers:

- `_synapse/agents/*.md` → `AgentDefinition` subagents
- `_synapse/skills/*/SKILL.md` → skills (invocable via `/name`)
- `_synapse/.mcp.json` → MCP server configs

No explicit reload is needed after writing a new artifact — the next query picks it up.

---

## 7. The self-improve workflow

The self-improve system lets you teach Synapse how to behave using plain language in chat.
Synapse recognizes customization intent and offers to create or modify `_synapse/` artifacts.

**How it works:**

1. You express a preference or behavioral wish in chat (e.g. "use Zettelkasten format for
   research notes" or "always check my inbox trigger is enabled").
2. Synapse's system prompt includes a `[Self-Improve]` detection block that teaches the
   active agent to recognize this intent.
3. The agent proposes creating or modifying an agent, skill, or trigger artifact.
4. The agent always asks for confirmation before writing to `_synapse/`.
5. On confirmation, it writes the artifact using the correct SDK-native format.
6. The next query picks up the new artifact automatically.

**Starter skill — `improve-synapse`:**

On first install, Synapse seeds `_synapse/skills/improve-synapse/SKILL.md`. Invoking it with
`/improve-synapse` gives the active agent full context about the `_synapse/` format and its
write capabilities.

---

## 8. Settings integration

### Initialize button (Settings → Capabilities)

Creates the `_synapse/` folder structure and seeds the five default agents and the
`improve-synapse` skill. Safe to run on an existing vault — it does not overwrite existing files.

### Trigger management (Settings → Triggers)

Lists all triggers found in `_synapse/triggers/`. Provides an enable/disable toggle (writes
`enabled: false` to the trigger's frontmatter), shows the last-fired timestamp, and an **Open
triggers folder** button.

### Feature → Agent map (Settings → Feature Map & Agents)

Assign any named agent to each feature. Model bindings for agents are editable directly in
Settings — the plugin writes the change to the agent's `.md` file frontmatter.

---

## 9. Tips and patterns

### Keep agents focused

One agent per role is better than one monolithic agent. Use the feature→agent map to assign
the right agent to each context (chat vs. inline vs. vision vs. Telegram).

### Use skills for reusable instructions

Skills compose cleanly: enable multiple skills per session to layer behaviours (e.g.
`harvard-citations` + `literature-synthesis`). Keep skill prompts focused and actionable.

### Use triggers for recurring vault maintenance

Triggers run unattended. Use local models (Ollama/Foundry Local) for cheap high-frequency
triggers (auto-tagging, daily lint) and Claude for agentic ones (weekly research digest).

### Scope triggers with path globs

A trigger without a `path` glob fires for every file event. Always scope triggers to avoid
running on unintended files:

```yaml
path: inbox/**          # only files under inbox/
path: projects/*.md     # only top-level project notes
path: research/**/*.md  # all md files under research/
```

### Version-control `_synapse/`

Commit `_synapse/` to git (if your vault is a repo) to track customization history and share
configurations between machines.

---

## 10. Suggested reading

- [`Local-Models-ReAct.md`](Local-Models-ReAct.md) — guide to configuring and using local models (qwen3, gemma4, nemotron) in a tool-calling ReAct loop with stdio MCP servers.
- [`.docs/decisions/2026-06-29-native-sdk-customization-model.md`](../.docs/decisions/2026-06-29-native-sdk-customization-model.md) —
  decision record explaining why this native SDK model replaced the old Copilot-era custom loader.
- [`.docs/decisions/2026-06-28-claude-agent-sdk-migration.md`](../.docs/decisions/2026-06-28-claude-agent-sdk-migration.md) —
  the migration decision that introduced the agent-first routing model.
- [`.docs/specs/bots-triggers.md`](../.docs/specs/bots-triggers.md) — technical spec for the trigger
  system (parse rules, glob matching, cron format, write modes).
- [`.docs/specs/config-writer.md`](../.docs/specs/config-writer.md) — technical spec for config-writer
  (`writeAgent`, `writeSkill`, `writeTrigger`, etc.).
- [Claude Agent SDK documentation](https://docs.anthropic.com/en/docs/claude-code/sdk) —
  authoritative reference for `AgentDefinition` fields, `Options`, MCP config, and skills.
