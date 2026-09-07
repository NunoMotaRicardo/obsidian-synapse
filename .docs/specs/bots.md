# bots

## Telegram bot (`src/bots/`)

- `telegramApi.ts`: thin long-polling Bot API client (no webhooks). `telegramBot.ts`: bridge.
- Allowlist of numeric user ids; messages from others are silently ignored.
- One session per chat/topic; `/new` resets, `/help` explains.
- Attachments (photo/document/audio/video) are downloaded and passed as SDK attachments.
- Uses the default agent from settings; skills and MCP servers are discovered natively via the
  `_synapse/` plugin registration (passed in session `Options.plugins`).
- The `[Self-Improve]` detection block (its static body only — `buildSelfImproveHint()`,
  issue #201) is appended to the bot's system prompt; `buildBotSessionConfig()` keeps only
  session-stable content there (vault root, `buildResilienceHint()`, the static self-improve
  body). The bot's default agent name and working directory are volatile per the same stable/
  volatile split `chat-view.md` describes, so `processMessage()` inlines them into each
  outgoing message text via `buildCurrentAgentLine()` instead — even though in practice
  neither actually changes between messages in the same chat/topic today, keeping this call
  site consistent with the chat and search paths costs nothing. The bot's system prompt is
  delivered as `{type: 'preset', preset: 'claude_code', append: ...}` — appended to Claude
  Code's default prompt so unattended tool use (with `bypassPermissions`) keeps working.
- Runs only while Obsidian is open and connected.
- **Tool approval policy — deliberately not `settings.toolApproval` (issue #151).** Every bot
  session runs `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`
  unconditionally, in `buildBotSessionConfig()`. This is a standing exception to the unified policy
  batch loops now follow (see "Tool approval policy" under
  [run-executor.md](run-executor.md)): the bot's whole purpose is unattended remote control of the
  vault from a phone, and unlike a batch loop it has no per-message frontmatter to opt back into
  `'allow'` with — so making the bot follow `'ask'` would silently stop it from writing the moment
  someone flips the global setting for an unrelated reason (e.g. wanting search/editor actions to
  prompt), with no way to recover write access for just the bot. The bot's actual safety control is
  the numeric allowlist gating who can reach it at all (`connect()`/`handleMessage()`) — see
  [SECURITY.md](../../SECURITY.md) #1. A bot-specific approval setting is a possible follow-up, not
  something this issue does silently.
