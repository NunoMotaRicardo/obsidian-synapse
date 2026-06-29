# Architecture overview

Synapse (`obsidian-synapse`) is a desktop Obsidian plugin that embeds a Claude-native AI
assistant. It talks to the Claude CLI via `@anthropic-ai/claude-agent-sdk`, spawning a fresh
CLI process per query.

```
┌──────────────────────────────────────────────────────────────┐
│ Obsidian (Electron renderer, Node integration)               │
│                                                              │
│  main.ts ──► AgentService (src/copilot.ts)                   │
│  │               │  @anthropic-ai/claude-agent-sdk           │
│  │               ▼                                           │
│  │           claude CLI process (spawned per query)          │
│  │                                                           │
│  ├─► SynapseView (chat/search panel)                         │
│  ├─► Editor integration (context menu)                        │
│  └─► Bots (Telegram long-polling)                            │
│                                                              │
│  _synapse/  (SDK local plugin — agents, skills, .mcp.json)   │
└──────────────────────────────────────────────────────────────┘
```

## Modules

| Module | Spec | Source | Responsibility |
|---|---|---|---|
| main | — | `src/main.ts` | Plugin lifecycle, service wiring, commands, ribbon |
| agent-service | [copilot-service.md](copilot-service.md) | `src/copilot.ts` | SDK query lifecycle, sessions, one-shot chat helpers |
| runtime-manager | [runtime-manager.md](runtime-manager.md) | `src/runtimeManager.ts` | CLI binary resolution, version/protocol check, install guidance |
| settings | [settings.md](settings.md) | `src/settings.ts` | Settings tab, provider/model config, persisted options |
| provider-models | [settings.md](settings.md) | `src/providerModels.ts` | Shared BYOK model-list fetch (`/v1/models`, `/api/tags`), used by Settings Test button and `onListModels` |
| config-writer | [config-loader.md](config-loader.md) | `src/configWriter.ts` | Write/modify/delete vault artifacts (self-improve), vault structure scan, first-run seeding |
| chat-view | [chat-view.md](chat-view.md) | `src/synapseView.ts`, `src/view/*` | Panel UI: toolbar, input, chat renderer, session sidebar, search |
| modals | [chat-view.md](chat-view.md) | `src/modals/*` | Tool approval, elicitation, user input, edit, vault scope |
| editor | [editor.md](editor.md) | `src/editor/*` | Context-menu AI actions |
| bots | [bots-triggers.md](bots-triggers.md) | `src/bots/*` | Telegram bot front-end |

## Vault customization (`_synapse/`)

The `_synapse/` folder in the user's vault is registered as an SDK local plugin via
`Options.plugins`. The SDK discovers artifacts natively:

- `_synapse/agents/*.md` → subagents (`AgentDefinition`)
- `_synapse/skills/*/SKILL.md` → skills (invocable via `/name`)
- `_synapse/.mcp.json` → MCP server configs

No custom config loader. The plugin provides write-side utilities (`configWriter.ts`) for the
self-improve feature and first-run seeding. A lightweight directory scan populates toolbar
dropdowns (display-only). See [config-loader.md](config-loader.md) for details.

## Key dependency facts (June 2026)

- `@anthropic-ai/claude-agent-sdk` — the plugin's sole SDK dependency. Spawns the `claude` CLI
  per query; no persistent connection.
- CLI resolution: settings override → global npm → platform-specific paths (see runtime-manager).
- Session options: `effort`, `model`, `systemPrompt`, `agents`, `agent`, `plugins`, `skills`,
  `mcpServers`, `canUseTool`, `onElicitation`.
- Local SDK type reference: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

## Process

- Specs in `specs/` describe target behavior per module. Update the spec in the same change
  that alters behavior.
- Work items are tracked as GitHub issues on `NunoMotaRicardo/obsidian-claude-brain` (`gh issue
  list/view/create/edit`); `in-progress` marks active work.
- Build: `npm run build` (tsc typecheck + esbuild bundle). Deploy/verify: see
  `.claude/skills/deploy-test/`.
