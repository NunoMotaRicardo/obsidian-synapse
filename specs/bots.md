# bots

## Telegram bot (`src/bots/`)

- `telegramApi.ts`: thin long-polling Bot API client (no webhooks), exposing `TelegramApiLike` —
  the structural seam interface `TelegramBotService` depends on (its constructor takes an adapter
  factory defaulting to the real `TelegramApi`; see Testing below). `telegramBot.ts`: bridge.
- Allowlist of numeric user ids; messages from others are silently ignored.
- One session per chat/topic; `/new` resets, `/help` explains.
- Attachments (photo/document/audio/video) are downloaded to `_synapse/bot-attachments/` and their
  absolute paths are inlined into the outgoing prompt text (the Agent SDK's `Options` has no
  top-level attachments field — a real path the model can `Read` itself is the only way the content
  reaches it, the same mechanism the chat view's `buildPrompt()` uses).
- Uses the default agent from settings; skills and MCP servers are discovered natively via the
  `_synapse/` plugin registration (passed in session `Options.plugins`).
- The `[Self-Improve]` detection block (its static body only — `buildSelfImproveHint()`) is
  appended to the bot's system prompt; `buildBotSessionConfig()` keeps only session-stable content
  there (vault root, `buildResilienceHint()`, the static self-improve body). The bot's default
  agent name and working directory are volatile per the same stable/volatile split `chat-view.md`
  describes, so `processMessage()` inlines them into each outgoing message text via
  `buildCurrentAgentLine()` instead — even though in practice neither actually changes between
  messages in the same chat/topic today, keeping this call site consistent with the chat and search
  paths costs nothing. The bot's system prompt is delivered as
  `{type: 'preset', preset: 'claude_code', append: ...}` — appended to Claude Code's default
  prompt so unattended tool use (with `bypassPermissions`) keeps working.
- Runs only while Obsidian is open and connected.
- **Tool approval policy — deliberately not `settings.toolApproval`.** Every bot session runs
  `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`
  unconditionally, passed as the `profile: 'unattendedBypass'` inlineChat() profile at the call
  site (issue #230 — `INLINE_CHAT_PROFILES` in `agentService.ts`; `buildBotSessionConfig()` no
  longer carries the permission fields itself). This is a standing exception to the unified policy
  unattended `runExecutor.ts`-backed runs follow (see \"Tool approval policy\" under
  [run-executor.md](run-executor.md)): the bot's whole purpose is unattended remote control of the
  vault from a phone, and it has no per-run override to opt back into `'allow'` if the global
  setting is `'ask'` (`resolveToolApprovalPolicy()` only ever reads `settings.toolApproval`) — so
  making the bot follow `'ask'` would silently stop it from writing the moment someone flips the
  global setting for an unrelated reason (e.g. wanting search/editor actions to prompt), with no
  way to recover write access for just the bot. Unlike a `runExecutor.ts`-backed run, the bot
  doesn't go through that policy machinery at all (it calls `AgentService.inlineChat()` directly
  with the `unattendedBypass` profile), so an `'ask'` denial there
  wouldn't even land in a report the way a `runExecutor.ts` run's does. The bot's actual safety
  control is the numeric allowlist gating who can reach it at all (`connect()`/`handleMessage()`)
  — see [SECURITY.md](../SECURITY.md) #1.

## Testing

`test/telegramBot.test.ts` exercises the bot behind a fake adapter injected at the
`TelegramApiLike` seam (`src/bots/telegramApi.ts` defines the interface next to the concrete
`TelegramApi`; `TelegramBotService`'s constructor takes an adapter factory defaulting to the real
`TelegramApi`, so the production call site — `main.ts`'s `connectTelegram()` — is unchanged).
No test talks to the network: `connect()`/`getMe`/long-polling/replies/typing/attachments all
resolve against the recorded fake, `inlineChat` is a mock on the plugin object (no live CLI), and
the one bonus test exercising the default factory runs the real `TelegramApi` against the mocked
`requestUrl` transport. The suite covers routing (allowlist enforcement, `/start`, `/help`, `/new`
commands, no-content drops), per-chat/topic queue serialization, reply splitting at the 4096 limit
plus the "can't parse" retry-as-plain-text path, typing-loop shutdown, attachment download
(largest-photo selection, filename sanitization, vault-adapter write), session resume identity, and
poll-loop backoff. Time-dependent paths (typing interval, poll backoff) run under fake timers.

