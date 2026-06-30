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

### Event watcher (`src/triggers.ts`)

`TriggerWatcher` registers Obsidian vault event listeners (create/modify/delete/rename)
and matches them against enabled event-based triggers loaded via `scanTriggers()`.

**Lifecycle:**

- Created in `main.ts` `onload()` after copilot initialization.
- `start()` loads trigger configs and registers vault listeners via `plugin.registerEvent()`.
- `stop()` clears debounce timers. Vault listeners are cleaned up by Obsidian on unload.

**Matching logic:**

1. Exclude files inside `_synapse/` to avoid feedback loops.
2. Debounce: 500ms per-file, collapsing rapid successive events on the same file.
3. For each enabled trigger with a matching `event` type:
   - If `path` glob is set, match against file path using `matchGlob()`.
   - If no `path`, the trigger matches all files.
4. On match: `console.log('[synapse] Trigger "<name>" fired for <file>')`.
   Actual execution is wired in a later issue (#51).

**Glob matching (`matchGlob`):**

Lightweight glob matcher for vault-relative paths:

- `*` matches any characters except `/` (single segment).
- `**` matches any path segments including nested.
- Literal path prefixes ending with `/` match any file under that directory.
- Combination patterns supported (e.g. `inbox/*.md`, `projects/**/notes/*.md`).

**Config auto-reload:**

Watches `_synapse/triggers/` for changes (create/modify/delete/rename of trigger files)
and reloads trigger configs with a 1-second debounce.

### Trigger executor (`src/triggerExecutor.ts`)

Receives a matched `TriggerConfig` and the triggering file path, runs the model, applies write
modes, and records execution.

**Entry point:**
```ts
executeTrigger(plugin: SynapsePlugin, trigger: TriggerConfig, filePath: string): Promise<void>
```

**Template substitution** — applied to `trigger.body` before the model call:
- `{{file}}` → vault-relative file path of the triggering file
- `{{files}}` → same (for scheduled triggers this would be a list; event triggers have one file)

**Model routing:**
- `trigger.model` absent or resolves to a Claude model → `AgentService.inlineChat()` with
  `model`, `agent`, `systemMessage` from trigger, `cwd` set to vault root (absolute basePath),
  `plugins` set to the `_synapse/` local plugin path (same pattern as bots and editor actions).
- `trigger.model` resolves to a local model → `executeLocalProviderQuery()` with file content
  prepended to the prompt as context, equipped with:
  - Built-in vault tools (`read_note`, `list_notes`, `search_notes`) from `vaultTools`.
  - MCP-bridged tools discovered from `_synapse/.mcp.json` via `McpBridgeSession` (see
    [mcp-bridge.md](mcp-bridge.md)) — web search, GitHub, or any other configured MCP server.
  Combined with the Obsidian `App` instance to enable a full ReAct tool-calling loop. If no MCP
  config is present, the bridge returns an empty list and execution continues with vault tools only.

**Write modes** (applied to the model response):

| `trigger.write` | Behavior |
|---|---|
| `false` (default) | Append result to `_synapse/reports/<name>-YYYY-MM-DD.md` (create if absent, append if same day) |
| `true` | Replace the triggering file's entire content with the model response |
| `'frontmatter'` | Parse response as YAML, merge keys into existing file frontmatter (body unchanged) |

**Report format** (write mode `false`):
```
# <trigger-name> — YYYY-MM-DD

<result>
```
The `_synapse/reports/` folder is created automatically if missing.

**Error handling:** errors are logged to console (`console.error`) and appended to the report
file under an `## Error` heading (so failures are visible in the vault).

**After execution:** `plugin.settings.triggerLastFired[trigger.name] = Date.now()` is set and
`plugin.saveSettings()` is called to persist the timestamp.

### Current status

Type definitions and parser/writer are implemented (issue #48). Event watcher is
implemented (issue #49) — detects vault events and matches triggers.

Scheduled trigger runner is implemented (issue #50): `TriggerScheduler` in `src/triggers.ts`
evaluates cron-scheduled triggers on a 60-second tick via `plugin.registerInterval()`.
Cron parsing supports the full 5-field standard format (minute, hour, day-of-month, month,
day-of-week) with wildcards (`*`), exact values, ranges (`N-M`), steps (`*/N`, `N/N`), and
comma-separated lists. `lastFired` is persisted in `settings.triggerLastFired` (keyed by
trigger name) so triggers don't re-fire within the same minute even across plugin reloads.

Trigger executor is implemented (issue #51) — `src/triggerExecutor.ts` runs matched triggers
against the configured model (local provider or Claude via `AgentService.inlineChat()`),
applies write modes, and appends results to `_synapse/reports/`.

`TriggerScheduler.tick()` calls `executeTrigger()` for matched scheduled triggers:

- If `trigger.path` is set, it's resolved against the whole vault via `resolveGlobFiles()`
  (matches `matchGlob()` against every `app.vault.getFiles()` path) and `executeTrigger()` runs
  once per matching file. No matches logs a `console.warn` and skips firing.
- If `trigger.path` is absent, there's no target file — `executeTrigger()` runs once with an
  empty file path, and the write mode is forced to `false` (report-only) regardless of the
  trigger's configured `write` setting, since there's no file to write back to.

`triggerLastFired` is stamped synchronously in `tick()` at match time (before the async
execution completes) to prevent double-dispatch across overlapping ticks — e.g. the immediate
startup tick racing the first interval tick. `executeTrigger()` also stamps it again on
completion.
