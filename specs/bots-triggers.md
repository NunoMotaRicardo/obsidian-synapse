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

## Triggers (`_synapse/triggers/`)

Triggers are vault-local automation definitions that fire either in response to vault events
or on a cron schedule. Each trigger is a markdown file with frontmatter metadata and a prompt
body.

### Trigger definition format

File location: `_synapse/triggers/<kebab-name>.md`

Frontmatter fields:

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | filename | Trigger identifier |
| `description` | string | yes | — | Short summary of what the trigger does |
| `event` | enum | one of event/schedule | — | `file-created`, `file-modified`, `file-deleted`, `file-renamed` |
| `schedule` | string | one of event/schedule | — | Cron expression (e.g. `0 9 * * *`) |
| `path` | string | no | — | Glob pattern scoping which files the trigger applies to |
| `model` | string | no | session default | Model alias (`sonnet`, `haiku`) or local model ID |
| `agent` | string | no | — | Agent name to use for execution |
| `write` | boolean or `'frontmatter'` | no | `false` | Whether the trigger may write back |
| `enabled` | boolean | no | `true` | Set to `false` to disable without deleting |

Body: prompt/instructions executed when the trigger fires. Template variables `{{file}}`
(event triggers) and `{{files}}` (scheduled triggers) are substituted at execution time.

### Validation rules

- `event` and `schedule` are **mutually exclusive** — a trigger with both is skipped with a
  `console.warn` at parse time.
- `event` must be one of the four valid values; invalid values cause the trigger to be skipped.
- `enabled` defaults to `true` when the field is omitted.
- `write` defaults to `false` when omitted.

### Event types

| Event | Fires when |
|---|---|
| `file-created` | A new file is created in the vault |
| `file-modified` | An existing file is saved with changes |
| `file-deleted` | A file is deleted or trashed |
| `file-renamed` | A file is moved or renamed |

### Schedule format

Standard five-field cron expressions: `minute hour day-of-month month day-of-week`.
Example: `0 9 * * *` = daily at 9:00 AM, `0 8 * * 1` = every Monday at 8:00 AM.

### Write modes

| Value | Behavior |
|---|---|
| `false` (default) | Read-only — trigger output is not written back |
| `true` | Full write — trigger may modify the target file(s) |
| `'frontmatter'` | Frontmatter-only — trigger may update frontmatter fields but not the body |

### Parser and writer

- `scanTriggers(app, folder)` in `configWriter.ts` reads `_synapse/triggers/*.md`, parses
  frontmatter via `parseFrontmatter()`, validates constraints, returns `TriggerConfig[]`.
- `writeTrigger(app, folder, config)` creates a trigger `.md` file with frontmatter + body.
- Both follow the same patterns as `scanAgents`/`writeAgent`.

### Current status

Type definitions and parser/writer are implemented (issue #48). Trigger execution (the
scheduler/event listener that actually fires triggers) is tracked in issue #14.
