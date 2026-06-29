# bots

## Telegram bot (`src/bots/`)

- `telegramApi.ts`: thin long-polling Bot API client (no webhooks). `telegramBot.ts`: bridge.
- Allowlist of numeric user ids; messages from others are silently ignored.
- One session per chat/topic; `/new` resets, `/help` explains.
- Attachments (photo/document/audio/video) are downloaded and passed as SDK attachments.
- Uses the default agent from settings; skills and MCP servers are discovered natively via the
  `_synapse/` plugin registration (passed in session `Options.plugins`).
- The `[Self-Improve]` detection block is appended to the bot's system prompt via
  `buildSelfImproveHint()`, using the bot's default agent name.
- Runs only while Obsidian is open and connected.

## Triggers (deferred)

The trigger system (cron/glob scheduled background AI tasks) has been removed. All trigger
source files (`triggerScheduler.ts`, `triggersPanel.ts`), the `TriggerConfig` type, and
related loader/writer/settings code have been deleted. SDK hooks do not map to this use
case — they fire during active agent sessions for agent-initiated events, not for vault-wide
cron/file-change automation. Triggers will be revisited as part of the loop features design
(issue #14). See `wiki/decisions/2026-06-29-native-sdk-customization-model.md`.
