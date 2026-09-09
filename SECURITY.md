# Security policy

Synapse embeds a Claude-native AI agent, running desktop-side, with access to your vault and to
whatever the agent's configured tools let it do. That's the point of the plugin, but it means the
capabilities below are worth understanding before you rely on them — none of them is a bug, and
all of them are surprising if you find out about them by reading the source instead of here.

## Supported versions

Synapse is distributed via BRAT (no plugin-store release yet). Only the latest tagged version
receives fixes; there is no back-porting to older tags.

## Reporting a vulnerability

Please do not open a public GitHub issue for a security vulnerability. Instead, use GitHub's
private vulnerability reporting for this repository (**Security → Report a vulnerability** on the
repo, or via [@NunoMotaRicardo](https://github.com/NunoMotaRicardo)'s profile if that flow isn't
available to you). This lets us discuss and fix the issue before any details are public.

## Threat model

### 1. The Telegram bot gives unattended, unapproved, full read/write agent access to your vault

`connect()` in `src/bots/telegramBot.ts` runs every Telegram-sourced message through the agent
with `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true`, with the
agent's working directory set to the vault root. Concretely: **anyone whose numeric Telegram user
ID is on your allowed-users list can read, create, edit, and delete files anywhere in your vault
from their phone, with no per-action approval and no one at the keyboard to catch a mistake.**
There is no scoping to a folder, no dry-run, no confirmation step for that channel.

The mitigations are real: connecting requires a non-empty, comma-separated numeric allowlist
(`TelegramBotService.connect()` refuses to connect otherwise), and the same allowlist is
re-checked for every incoming message before it's processed (`TelegramBotService.handleMessage()`,
which silently drops messages from senders not on the list). Keep that list short, keep the bot
token secret, and treat everyone on the allowlist as someone you'd hand your vault to unsupervised
— because that's what adding them does.

This is a deliberate, standing exception to the **tool approval** setting described in #3 below:
unattended runs going through `src/runExecutor.ts` honour `toolApproval` — `'ask'` denies a tool
call and logs the refusal to the run's report, since there's no one to actually ask — but the
Telegram bot does not, on purpose (issue #151). The bot's remote-control use case has no
equivalent opt-in to recover write access with if the global setting were flipped to `'ask'` for
an unrelated reason, so it stays unconditionally `bypassPermissions`, gated only by the allowlist
above.

### 2. MCP servers are arbitrary local processes

MCP server entries in a vault's `_synapse/.mcp.json` are started by spawning the configured
command as a local child process (`McpBridge`'s server-start path in `src/mcpBridge.ts`). That's
the intended MCP integration model, and it's implemented carefully — processes are spawned with
`shell: false` (no shell-string injection) and killed as a full process tree on Windows via
`taskkill /t` so nothing is left orphaned on disconnect. But it also means: **if you open a vault
that was synced or shared from a source you don't trust, and that vault's `_synapse/.mcp.json`
references an MCP server, Synapse will execute whatever that command is.** Vault-local MCP
configuration is effectively arbitrary code execution scoped to whoever controls the vault's
files, not just whoever controls Synapse's own settings.

### 3. `toolApproval: 'allow'` removes the approval step everywhere it applies

The **tool approval** setting, when set to allow, flips the agent session used by editor actions
(`src/editor/editorMenu.ts`), the edit modal (`src/modals/editModal.ts`), and the search panel
(`src/view/searchPanel.ts`) to `bypassPermissions` — the search panel additionally sets
`allowDangerouslySkipPermissions: true`. In that mode, none of those features stop to ask before
the agent reads, writes, or deletes a file, or runs a tool. It's the same trade-off as the
Telegram bot above (speed and flow over a human in the loop) but scoped to the desktop UI, where
you're the one at the keyboard. Understand what you're turning off before you turn it on.

The same setting also drives unattended runs going through `src/runExecutor.ts` (issue #151):
`allow` lets them write without asking, same as above; `ask` (the default) denies their tool calls
instead of prompting, since an unattended run has no one at the keyboard to prompt — see
[specs/run-executor.md](specs/run-executor.md).

## Other things worth knowing

- Provider API keys and bot tokens are kept out of `data.json` and stored via Obsidian's
  local-storage-backed secure fields in `src/settings.ts` — but "secure" here means "not synced in
  your vault's plaintext settings file," not encrypted at rest on disk.
- Synapse talks to a system-installed `claude` CLI over JSON-RPC (via
  `@anthropic-ai/claude-agent-sdk`) and, depending on your configured provider, to that provider's
  API over the network. There is no other outbound network access from the plugin itself beyond
  what MCP servers and the Telegram bot introduce as described above.
