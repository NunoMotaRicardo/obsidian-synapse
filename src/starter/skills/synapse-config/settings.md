# Permissions: `_synapse/settings.json`

`_synapse/settings.json` is this vault's own Claude settings layer. Synapse reads it on every query and merges it beneath the user's other Claude settings. It is the **only** place to grant or restrict tools for Synapse chats — do not create or edit `.claude/settings.json`, `.claude/settings.local.json`, or `~/.claude/settings.json` for this.

Synapse ships it with a minimal default: read files in the vault, nothing else.

```json
{
  "permissions": {
    "allow": ["Read(./**)"]
  }
}
```

## Format

Only `permissions` matters here. Each list holds rule strings, `Tool` or `Tool(pattern)`:

| List | Effect |
| --- | --- |
| `allow` | run without asking |
| `ask` | always prompt |
| `deny` | never run (wins over `allow`) |

Rule examples (paths are relative to the vault root):

- `Read(./**)` — read any file in the vault
- `Write(./Notes/**)` / `Edit(./Notes/**)` — modify files under `Notes/`
- `Write` / `Edit` — modify any file, including outside the vault (broad — say so when proposing it)
- `Bash(git status)` — one exact command; `Bash(git diff:*)` — a command prefix
- `mcp__<server>__<tool>` — one MCP tool

Prefer the narrowest rule that does the job: a folder over the whole vault, an exact command over a wildcard.

## Steps

1. **Read** `_synapse/settings.json` if it exists (it may not, or may hold other keys).
2. **Propose** the exact rule strings and the list each goes in (permission model applies — this file controls what runs unprompted, so always ask first, and warn when a rule is broad).
3. **Write** after approval. Keep every existing key and rule, add the new ones to the right list, and keep the file valid JSON. Done when the file parses and contains the approved rules.

Changes apply on the next message. The **Always allow** button in a tool-approval prompt writes to this same file, so rules added that way already appear here.
