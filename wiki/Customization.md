# Claude Synapse: AI Customization Guide

This guide explains the **vault-local customization model** of the Claude Synapse Obsidian plugin.
Claude Synapse reads your customization artifacts from a `_synapse/` folder in your vault and passes
them to the Claude Agent SDK as a native plugin — so your agents, skills, and MCP tools are
first-class SDK primitives, not a custom format layered on top.

> This guide reflects the **Claude Agent SDK** codebase (post June 2026 migration). For the
> history of the migration and the decisions behind it, see:
> [`.docs/decisions/2026-06-28-claude-agent-sdk-migration.md`](../.docs/decisions/2026-06-28-claude-agent-sdk-migration.md)
> and [`.docs/decisions/2026-06-29-native-sdk-customization-model.md`](../.docs/decisions/2026-06-29-native-sdk-customization-model.md).

---

## 1. The `_synapse/` folder layout

Claude Synapse reads from a single hardcoded folder in your vault:

```text
_synapse/                 ← registered as an SDK local plugin on every session
  agents/
    *.md                  ← agent definitions (SDK AgentDefinition format)
  skills/
    <name>/
      SKILL.md            ← skill instructions (invocable via /name)
      ...optional resources...
  .mcp.json               ← MCP server configs (SDK-native format)
  settings.json           ← vault settings layer (permissions, env, model overrides, ...)
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

### Frontmatter fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Display name in the agent picker |
| `description` | Yes | When to use the agent |
| `model` | No | Preferred model, selected automatically with the agent |
| `tools` | No | Allowed tools (omit for all) |
| `disallowedTools` | No | Explicitly blocked tools |
| `skills` | No | Skills the agent may use (omit for all, `[]` for none) |
| `mcpServers` | No | Per-agent MCP server overrides |

### Starter agent

The [starter kit](Starter-Kit.md) ships one agent, **Writer** (`writer.agent.md`), which drafts
finished prose and loads the `writing-style` skill. Use it as a model for your own agents.

### Feature → Agent map

In **Settings → Feature Map & Agents**, you can map each plugin feature to an agent from
`_synapse/agents/`:

| Feature | What it does |
|---|---|
| `chat` | Main chat panel sessions |
| `inline` | Editor context-menu text actions |
| `search` | AI vault search |
| `telegram` | Telegram bot sessions |
| `vision` | Image extraction, vision actions |

Every feature defaults to **Auto**, Claude's default agent. You can remap any feature and bind a
specific model to each agent, including a local model (e.g. `qwen3:8b` via Ollama).

### Self-improve: creating agents from chat

If you tell Claude Synapse what kind of assistant behavior you want, it will offer to create or
modify an agent for you, using the starter kit's `synapse-config` skill. Example:

> "Act more like a research synthesizer — focus on contrasting sources and flagging gaps"
> → Claude Synapse offers to update or create a `research.md` agent in `_synapse/agents/`

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

Every skill in `_synapse/skills/` is available in every session. The agent loads a skill's
`SKILL.md` when a request matches its `description`, so write descriptions as triggers. An agent's
`skills` frontmatter field limits which skills it may use.

You can also run a skill directly by typing `/name` in the chat input.

### Self-improve: creating skills from chat

> "Always use the Harvard citation format in research notes"
> → Claude Synapse offers to create a `harvard-citations` skill

---

## 4. MCP servers (`_synapse/.mcp.json`)

Configures MCP servers that the Claude Agent SDK discovers and spawns natively for every
session — Claude or local (a local agent endpoint model, below, runs through the same CLI, so
it sees the same `.mcp.json` servers).

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

### Example: browser use with Playwright

Let Claude Synapse drive a real browser to navigate, click, fill forms, take screenshots, and extract
content:

1. Install the [Playwright MCP Bridge](https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm)
   extension in a Chromium browser (Edge, Chrome).
2. Add the server to `_synapse/.mcp.json`:

```json
{
  "mcpServers": {
    "playwright-extension": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--extension"]
    }
  }
}
```

---

## 5. Vault settings (`_synapse/settings.json`)

An optional JSON file carrying vault-scoped settings — permission rules, environment values, a
default model override, and anything else the [Claude Code settings
schema](https://code.claude.com/docs/en/settings#available-settings) supports. It's Claude Synapse's own
settings layer, distinct from the plugin's own preferences (Settings tab, stored in Obsidian's
`data.json`): this file follows the **vault**, not any one session's working directory, so it
applies the same whether you're chatting from the vault root or with the working directory
scoped to a subfolder.

### Format

```jsonc
{
  "permissions": {
    "deny": ["Bash(rm -rf *)"],
    "allow": ["Read"]
  },
  "env": {
    "SOME_NON_SECRET_FLAG": "1"
  }
}
```

Any field from the Claude Code settings schema is accepted — `permissions`, `env`, `model`,
`fallbackModel`, and more.

> **Don't put secrets here.** This file is plaintext inside your vault, so it travels with
> everything that copies the vault — Obsidian Sync, git, a backup, a shared folder. API keys and
> tokens belong in Claude Synapse's own settings (Settings → **Claude Synapse**), which keeps them out of the
> vault. Note also that `permissions.allow` rules in this file grant tools silently, with no
> approval prompt — treat a vault someone else wrote this file for the same way you'd treat their
> `.mcp.json`.

### How it's applied

- Read fresh (and re-parsed) on every query — editing the file takes effect on your very next
  message, no reload needed.
- Applies to every Claude Synapse-initiated query: the chat panel, editor actions, the edit modal,
  vault search, and the Telegram bot — regardless of which one started the
  query or what its working directory is scoped to.
- **In-conversation tool approvals still work.** If you approve a tool mid-conversation, that
  approval is layered *on top of* this file rather than replacing it — a `permissions.deny` rule
  here still blocks that tool even after an unrelated approval elsewhere in the same chat.
- **Claude Synapse writes to this file in exactly one place: the tool-approval modal's "Always allow"
  action** (see below). Outside of that, Claude Synapse never creates or writes it — a vault with none,
  and that never clicks "Always allow", behaves exactly as if the feature didn't exist.
- If the file exists but isn't valid JSON, Claude Synapse shows a one-time notice and proceeds without
  applying any of it — it won't repeatedly warn you on every message for the same broken file,
  and a syntax error here never blocks a query outright.

### Permanently allowing a tool ("Always allow")

When Claude Synapse's tool-approval modal opens (prompting you to approve a tool call), it offers three
actions:

- **Allow** — grants the tool for the current conversation only. Nothing is written to disk; a new
  conversation prompts again.
- **Always allow** — grants the tool for the current conversation *and* permanently, by writing the
  rule into this file's `permissions.allow` list. A new conversation does not re-prompt for the
  same rule.
- **Deny** — refuses the tool call.

Before you can click **Always allow**, the modal shows you the **exact rule string** it would
write — not a summary. This matters: for a tool call outside your vault (e.g. reading a file in an
attached folder), the CLI can suggest a very broad rule shaped like `Read(//d//**)` (an entire
drive). Read what's shown before making it permanent — narrower is safer.

**There is no in-app UI to remove a persisted grant.** To revoke one, open
`_synapse/settings.json` yourself and delete the entry from `permissions.allow` (or delete the
whole file if you have nothing else in it worth keeping).

### Relationship to Claude Code's own settings files

This file is separate from — and takes priority over — the settings files the underlying Claude
CLI itself understands (`~/.claude/settings.json`, a vault-root `.claude/settings.json`,
`.claude/settings.local.json`). Claude Synapse tells the CLI which of *those* to load:

- Your **global** `~/.claude/settings.json` still applies, same as using the CLI directly.
- A **vault-root** `.claude/settings.json` (and any vault-root `CLAUDE.md`) still applies too.
- A **`.claude/settings.local.json`** — the CLI's own local, machine-specific override file,
  normally meant to be gitignored per-project — is **never read** by Claude Synapse. This closes a leak
  from an earlier version of the plugin, which briefly wrote stale tool-approval grants into that
  file; those grants no longer apply even if the file still exists in your vault. There's no
  setting to change this — if you rely on `.claude/settings.local.json` outside Claude Synapse (e.g. with
  the CLI directly), it still works there, it's just invisible to Claude Synapse-initiated queries.

---

## 6. How the SDK discovers your customizations

On every chat session or query, Claude Synapse passes `_synapse/` to the Claude Agent SDK as a
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

The self-improve system lets you teach Claude Synapse how to behave using plain language in chat.
Claude Synapse recognizes customization intent and offers to create or modify `_synapse/` artifacts.

**How it works:**

1. You express a preference or behavioral wish in chat (e.g. "use Zettelkasten format for
   research notes" or "be more concise in your replies").
2. Claude Synapse's system prompt includes a `[Self-Improve]` detection block that teaches the
   active agent to recognize this intent.
3. The agent proposes creating or modifying an agent or skill artifact.
4. The agent always asks for confirmation before writing to `_synapse/`.
5. On confirmation, it writes the artifact using the correct SDK-native format.
6. The next query picks up the new artifact automatically.

**Starter skill — `synapse-config`:**

The [starter kit](Starter-Kit.md#synapse-config) includes `_synapse/skills/synapse-config/`. It
holds the full `_synapse/` formats, the propose-then-write permission model, and the setup
workflow that builds writing styles from your own documents. The self-improve hint points the
agent to it. You can also run it directly with `/synapse-config`.

---

## 8. Settings integration

### Initialize button (Settings → Capabilities)

Installs the [starter kit](Starter-Kit.md): the Writer agent and the `synapse-config`,
`obsidian`, `think`, and `writing-style` skills. It runs automatically the first time Claude Synapse loads
in a vault without `_synapse/`. It's safe to run on an existing vault: it only adds missing files
and never overwrites.

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

### Version-control `_synapse/`

Commit `_synapse/` to git (if your vault is a repo) to track customization history and share
configurations between machines.

---

## 10. Suggested reading

- [Starter kit](Starter-Kit.md) — the bundled agent and skills, and the setup workflow.
- [`Local-Models-Ollama.md`](Local-Models-Ollama.md) — guide to configuring a local Ollama endpoint (including Ollama Cloud models and context-window tuning).
- [`.docs/decisions/2026-06-29-native-sdk-customization-model.md`](../.docs/decisions/2026-06-29-native-sdk-customization-model.md) —
  decision record explaining why this native SDK model replaced the old Copilot-era custom loader.
- [`.docs/decisions/2026-06-28-claude-agent-sdk-migration.md`](../.docs/decisions/2026-06-28-claude-agent-sdk-migration.md) —
  the migration decision that introduced the agent-first routing model.
- [`specs/config-writer.md`](../specs/config-writer.md) — technical spec for config-writer
  (`writeSkill`, scans, tool-approval persistence).
- [Claude Agent SDK documentation](https://docs.anthropic.com/en/docs/claude-code/sdk) —
  authoritative reference for `AgentDefinition` fields, `Options`, MCP config, and skills.
