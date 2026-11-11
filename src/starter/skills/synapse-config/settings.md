# Permissions: the plugin's `settings.json`

The plugin folder's `settings.json` — `<config folder>/plugins/claude-synapse/settings.json`, usually `.obsidian/plugins/claude-synapse/settings.json` — is Synapse's own Claude settings layer. It is **per device** and deliberately not in `_synapse/`, which is synced. Ignore any `settings.json` left in `_synapse/`: it is only a legacy copy. Because the file is per device, a rule added here applies on this device only — say so when you change permissions. Synapse reads it on every query and merges it beneath the user's other Claude settings. It is the **only** place to grant or restrict tools for Synapse chats — do not create or edit `.claude/settings.json`, `.claude/settings.local.json`, or `~/.claude/settings.json` for this.

Synapse ships it with a minimal default: read files, nothing else.

```json
{
  "permissions": {
    "allow": ["Read"]
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

- `Read` — read any file (the default; a path-scoped `Read(./**)` did not match in practice)
- `Write(./Notes/**)` / `Edit(./Notes/**)` — modify files under `Notes/`
- `Write` / `Edit` — modify any file, including outside the vault (broad — say so when proposing it)
- `Bash(git status)` — one exact command; `Bash(git diff:*)` — a command prefix
- `mcp__<server>__<tool>` — one MCP tool

Prefer the narrowest rule that does the job: a folder over the whole vault, an exact command over a wildcard.

## Directories outside the vault

A folder outside the vault (including the target of a symlinked vault folder) is granted with `permissions.additionalDirectories`, a list of **real absolute paths** — not with one `Read(//path/**)` rule per file. Resolve links first (`readlink -f`); a path that runs through a link is treated as outside. See [setup.md](_synapse/skills/synapse-config/setup.md) for the guided flow.

## Steps

1. **Read** that `settings.json` if it exists (it may not, or may hold other keys).
2. **Propose** the exact rule strings and the list each goes in (permission model applies — this file controls what runs unprompted, so always ask first, and warn when a rule is broad).
3. **Write** after approval. Keep every existing key and rule, add the new ones to the right list, and keep the file valid JSON. Done when the file parses and contains the approved rules.

Changes apply on the next message. The **Always allow** button in a tool-approval prompt writes to this same file, so rules added that way already appear here.

## Tidy permissions

The **Always allow** button adds one very specific rule per approval, so the list grows noisy. Offer a tidy-up when the user asks, when setup finishes, or when you see many narrow rules while editing the file. Never tidy silently.

1. **Read** the file and count the rules.
2. **Propose** a compact version (permission model applies — show before and after):
   - Drop rules a broader rule already covers — a bare `Read`, `Edit`, `Write` or `Bash` covers every `Tool(...)` rule of that tool; a rule covers any narrower one for the same tool.
   - Merge path aliases for the same folder (a symlink and its target) into one `additionalDirectories` entry.
   - Replace per-domain `WebFetch(domain:…)` rules with bare `WebFetch`, and per-tool `mcp__<server>__<tool>` rules with `mcp__<server>` — but **never** widen a server that has tools which trade, send, delete or otherwise change things; keep those individual and tell the user which ones you left.
   - Drop one-off commands: a `Bash(...)` rule holding a whole `cd … && …` chain, or a specific file name, will not match again. Suggest a prefix rule (`Bash(mv:*)`) only when the user says they repeat that kind of command; never for `python`, `bash -c`, `sh`, `eval`, `ssh`, `sudo`, `rm`.
3. **Write** after approval, keeping unrelated keys. Done when the file parses and the user has seen the before/after count.
