# Architecture overview

Obsidian Sidekick (this fork: `obsidian-copilot`) is a desktop Obsidian plugin that embeds
GitHub Copilot as a personal assistant. It talks to the Copilot runtime (the `copilot` CLI)
through `@github/copilot-sdk` over JSON-RPC.

```
┌──────────────────────────────────────────────────────────────┐
│ Obsidian (Electron renderer, Node integration)               │
│                                                              │
│  main.ts ──► CopilotService (src/copilot.ts)                 │
│  │               │  @github/copilot-sdk (JSON-RPC client)    │
│  │               ▼                                           │
│  │           copilot CLI process (spawned, stdio)            │
│  │                                                           │
│  ├─► SidekickView (chat/search/triggers panel)               │
│  ├─► Editor integration (context menu)                        │
│  ├─► TriggerScheduler (cron/glob background tasks)           │
│  └─► Bots (Telegram long-polling)                            │
└──────────────────────────────────────────────────────────────┘
```

## Modules

| Module | Spec | Source | Responsibility |
|---|---|---|---|
| main | — | `src/main.ts` | Plugin lifecycle, service wiring, commands, ribbon |
| copilot-service | [copilot-service.md](copilot-service.md) | `src/copilot.ts` | SDK client lifecycle, sessions, one-shot chat helpers |
| runtime-manager | [runtime-manager.md](runtime-manager.md) | `src/runtimeManager.ts` | CLI binary resolution, version/protocol check, install guidance |
| settings | [settings.md](settings.md) | `src/settings.ts` | Settings tab, provider/model config, persisted options |
| provider-models | [settings.md](settings.md) | `src/providerModels.ts` | Shared BYOK model-list fetch (`/v1/models`, `/api/tags`), used by Settings Test button and `onListModels` |
| config-loader | [config-loader.md](config-loader.md) | `src/configLoader.ts` | Vault `sidekick/` folder: agents, skills, tools, prompts, triggers |
| chat-view | [chat-view.md](chat-view.md) | `src/sidekickView.ts`, `src/view/*` | Panel UI: toolbar, input, chat renderer, session sidebar, search, triggers tab |
| modals | [chat-view.md](chat-view.md) | `src/modals/*` | Tool approval, elicitation, user input, edit, vault scope |
| editor | [editor.md](editor.md) | `src/editor/*` | Context-menu AI actions |
| bots | [bots-triggers.md](bots-triggers.md) | `src/bots/*` | Telegram bot front-end |
| scheduler | [bots-triggers.md](bots-triggers.md) | `src/triggerScheduler.ts`, `src/tasks.ts` | Cron/glob trigger execution |

## Key dependency facts (June 2026)

- `@github/copilot-sdk` **1.0.1** (GA 2026-06-02). Speaks **SDK protocol v3**; requires a
  CLI new enough to speak it (CLI ≥ ~1.0.5x; older `--headless --stdio` interface was removed).
- The SDK npm package depends on `@github/copilot@^1.0.61` (bundled runtime), but Obsidian
  plugins ship as a single `main.js` — the runtime is **not** bundled. The plugin resolves a
  system-installed CLI (see runtime-manager spec).
- `reasoningEffort` (`low|medium|high|xhigh`), `reasoningSummary`, `contextTier`,
  `infiniteSessions` are session-level options in SDK 1.0.
- Local SDK type reference: `node_modules/@github/copilot-sdk/dist/types.d.ts`.

## Process

- Specs in `specs/` describe target behavior per module. Update the spec in the same change
  that alters behavior.
- Work items are tracked as GitHub issues on `NunoMotaRicardo/obsidian-copilot` (`gh issue
  list/view/create/edit`); `in-progress` marks active work. See `.claude/skills/sidekick-build/`
  and `.claude/skills/sidekick-lite/`.
- Build: `npm run build` (tsc typecheck + esbuild bundle). Deploy/verify: see
  `.claude/skills/deploy-test/`.
