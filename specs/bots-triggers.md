# bots & triggers

## Triggers (`src/triggerScheduler.ts`, `src/tasks.ts`)

- `*.trigger.md` files define background tasks: `cron` (checked every 60 s) and/or `glob`
  (vault file create/modify/rename).
- Execution: `CopilotService.inlineChat()` with the trigger's agent config; session persists
  and appears in the sidebar tagged `[trigger]`; file-change triggers append the changed path
  to the prompt.
- Firing history is surfaced in the Triggers tab.

## Telegram bot (`src/bots/`)

- `telegramApi.ts`: thin long-polling Bot API client (no webhooks). `telegramBot.ts`: bridge.
- Allowlist of numeric user ids; messages from others are silently ignored.
- One Copilot session per chat/topic; `/new` resets, `/help` explains.
- Attachments (photo/document/audio/video) are downloaded and passed as SDK attachments.
- Uses the default agent from settings, all configured MCP tools/skills, and the persisted
  `reasoningEffort`/`reasoningSummary` (same rules as chat-view).
- Runs only while Obsidian is open and connected.
