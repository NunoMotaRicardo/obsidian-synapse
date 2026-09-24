# bots

## Telegram bot (`src/bots/`)

- `telegramApi.ts`: thin long-polling Bot API client (no webhooks), exposing `TelegramApiLike` —
  the structural seam interface `TelegramBotService` depends on (its constructor takes an adapter
  factory defaulting to the real `TelegramApi`; see Testing below). `telegramBot.ts`: bridge.
- A non-empty comma-separated user-ID allowlist is required before connecting. Sender IDs
  are matched as strings against the trimmed entries; unknown or absent senders are silently ignored.
- One session per chat/topic; `/new` resets, `/help` explains. Reset and disconnect hard-abort an in-flight SDK query through `abortWithSetTimeoutShim()` so Electron's numeric timer handles cannot trigger the SDK's `.unref()` teardown error.
- Attachments (photo/document/audio/video) are downloaded to `_synapse/bot-attachments/` through
  the Vault API (`ensureFolder()` and `createBinary()`), then their absolute paths are inlined into
  the outgoing prompt text. The Agent SDK's `Options` has no top-level attachments field — a real
  path the model can `Read` itself is the only way the content reaches it, the same mechanism the
  chat view's `buildPrompt()` uses.
- Uses `featureAgents.telegram` before the legacy `telegramDefaultAgent`, resolves its model
  binding against available models, and passes non-empty global reasoning effort as `effort`; skills and MCP servers are discovered natively via the
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
  longer carries the permission fields itself). This deliberately overrides the global tool
  approval setting rather than following it: the bot's whole purpose is unattended remote control
  of the vault from a phone, and it has no per-run override to opt back into `'allow'` if the
  global setting is `'ask'` — so making the bot follow `'ask'` would silently stop it from
  writing the moment someone flips the global setting for an unrelated reason (e.g. wanting
  search/editor actions to prompt), with no way to recover write access for just the bot. The
  bot calls `AgentService.inlineChat()` directly with the `unattendedBypass` profile — there is
  no policy machinery to opt out of. The bot's actual safety
  control is the numeric allowlist gating who can reach it at all (`connect()`/`handleMessage()`)
  — see [SECURITY.md](../SECURITY.md) #1.
- **Dangerous-`rm` check under `bypassPermissions` (issue #269 AC-2, verified against CLI
  2.1.281).** CLI 2.1.281 added a static-analysis safety check that flags an `rm` whose target
  can't be resolved before the command runs (e.g. a `$(...)` command substitution) and denies it
  outright as `decision_reason_type: "safetyCheck"` — this fires even under
  `bypassPermissions`/`allowDangerouslySkipPermissions: true`, and does **not** go through
  `canUseTool` (the bot has none wired), since the SDK only passes
  `--permission-prompt-tool stdio` when `canUseTool` is set at all. Verified directly against the
  real CLI in an isolated empty temp directory (never the repo or vault):
  `claude -p "Run exactly this Bash command and nothing else: rm -rf \"$(echo
  /nonexistent-synapse-rm-probe-269)\"" --permission-mode bypassPermissions --output-format
  stream-json --verbose --max-turns 2 --model claude-haiku-4-5-20251001` — the target path doesn't
  exist, so the command is harmless even if it had run. Result: the `Bash` tool call was **denied
  immediately** (`system`/`permission_denied` message, reason "Dangerous rm operation on
  statically-unresolvable target: command substitution output"), with **no ~2-minute stall** —
  the whole two-turn run (including the model's own follow-up turn after the denial) completed in
  14 seconds. This CLI version/config does not reproduce the "asks and waits up to 2 minutes,
  then denies" behavior the issue was concerned about, so no `canUseTool`/env-var fix
  (`CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT`) was added to the bot — there is nothing here for
  either to fix. If a future CLI version reintroduces a real stall, re-run this same probe first
  to confirm before adding a workaround.

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
(largest-photo selection, filename sanitization, Vault API binary creation), session resume identity, and
poll-loop backoff. Time-dependent paths (typing interval, poll backoff) run under fake timers.

