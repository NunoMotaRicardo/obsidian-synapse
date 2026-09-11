# Architecture overview

Synapse (`obsidian-synapse`) is a desktop Obsidian plugin that embeds a Claude-native AI
assistant. It talks to the Claude CLI via `@anthropic-ai/claude-agent-sdk`, spawning a fresh
CLI process per query.

```
┌──────────────────────────────────────────────────────────────┐
│ Obsidian (Electron renderer, Node integration)               │
│                                                              │
│  main.ts ──► AgentService (src/agentService.ts)               │
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
| agent-service | [agent-service.md](agent-service.md) | `src/agentService.ts` | SDK query lifecycle, sessions, one-shot chat helpers |
| runtime-manager | [runtime-manager.md](runtime-manager.md) | `src/runtimeManager.ts` | CLI binary resolution, version/protocol check, install guidance |
| settings | [settings.md](settings.md) | `src/settings.ts` | Settings tab, provider/model config, persisted options |
| provider-models | [agent-service.md](agent-service.md) | `src/providerModels.ts` | Local agent endpoint (#122) discovery — `fetchEndpointModels()` (`/v1/models` catalogue) and `testLocalAgentEndpoint()` (Settings Test button); the OpenAI-compatible provider matrix and its `executeLocalProviderQuery()` ReAct loop were removed (#220) |
| config-writer | [config-writer.md](config-writer.md) | `src/configWriter.ts` | Write/modify/delete vault artifacts (self-improve), vault structure scan, first-run seeding |
| chat-view | [chat-view.md](chat-view.md) | `src/synapseView.ts`, `src/view/*` | Panel UI: toolbar, input, chat renderer, session sidebar, search |
| modals | [chat-view.md](chat-view.md) | `src/modals/*` | Tool approval, elicitation, user input, edit, vault scope |
| editor | [editor.md](editor.md) | `src/editor/*` | Context-menu AI actions |
| bots | [bots.md](bots.md) | `src/bots/*` | Telegram bot front-end |
| run-executor | [run-executor.md](run-executor.md) | `src/runExecutor.ts` | Per-item run pipeline (substitute → run via `AgentService.inlineChat()` → apply write mode → append report); no in-tree caller since batch loops were removed (#221), kept as reusable infrastructure |
| lock-manager | [lock-manager.md](lock-manager.md) | `src/lockManager.ts` | In-memory per-file advisory write lock serializing plugin-initiated writes (config writes, report appends) |
| vault-paths | [vault-paths.md](vault-paths.md) | `src/vaultPaths.ts` | Vault base path resolution, `_synapse/` folder + SDK plugin config, reports folder, today's-date helper |

## Vault customization (`_synapse/`)

The `_synapse/` folder in the user's vault is registered as an SDK local plugin via
`Options.plugins`. The SDK discovers artifacts natively:

- `_synapse/agents/*.md` → subagents (`AgentDefinition`)
- `_synapse/skills/*/SKILL.md` → skills (invocable via `/name`)
- `_synapse/.mcp.json` → MCP server configs

No custom config loader. The plugin provides write-side utilities (`configWriter.ts`) for the
self-improve feature and first-run seeding. A lightweight directory scan populates toolbar
dropdowns (display-only). See [config-writer.md](config-writer.md) for details.

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
- Work items are tracked as GitHub issues on `NunoMotaRicardo/obsidian-synapse` (`gh issue
  list/view/create/edit`); `in-progress` marks active work.
- Build: `npm run build` (tsc typecheck + esbuild bundle). Deploy/verify: see
  `.claude/skills/deploy-test/`.

## Testing

An automated unit test suite is configured using Vitest.
- Run tests: `npm run test` (or `npx vitest run`)
- Interactive watch mode: `npm run test:watch` (or `npx vitest`)
- Environment: Node.js (via Vitest config)
- Mocking: Global mock for the Obsidian API is configured in `test/setup.ts` to mock native interfaces not available under Node.
- Files: Unit tests live in the `test/` directory, named `<module>.test.ts`.

