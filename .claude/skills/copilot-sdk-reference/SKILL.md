---
name: copilot-sdk-reference
description: Reference for the @github/copilot-sdk 1.x TypeScript API used by this plugin — migration map from 0.2.x, key types, connection model, and where to find authoritative type definitions. Use when working on src/copilot.ts, session config, models, or any SDK-related change.
---

# Copilot SDK 1.x reference (TypeScript)

> **Transitional / being superseded.** The plugin is migrating to the Claude Agent SDK — see
> `.claude/skills/claude-agent-sdk-reference/` and
> `.docs/decisions/2026-06-28-claude-agent-sdk-migration.md`. This reference documents the
> **current** Copilot-SDK code and stays useful only until the engine-swap issue removes it.

Authoritative source: `node_modules/@github/copilot-sdk/dist/*.d.ts` — especially `types.d.ts`
(options/configs), `client.d.ts`, `session.d.ts`. **Read them; don't trust memory.** The SDK
went GA 1.0.0 on 2026-06-02; CLIs ≥ ~1.0.5x dropped the old `--headless --stdio` interface,
so SDK 0.2.x cannot connect to current CLIs (SDK protocol is now v3, see
`sdkProtocolVersion.d.ts`).

## 0.2.x → 1.x migration map

| 0.2.x | 1.x |
|---|---|
| `new CopilotClient({cliPath})` | `new CopilotClient({connection: RuntimeConnection.forStdio({path})})` |
| `new CopilotClient({cliUrl})` | `connection: RuntimeConnection.forUri(url)` |
| `cwd` option | `workingDirectory` |
| `githubToken` | `gitHubToken` |
| `client.getState()` / `ConnectionState` | removed — track state app-side; `getStatus()` is an RPC returning CLI version/protocol |
| `session.getMessages()` | `session.getEvents()` |
| `MCPRemoteServerConfig` / `MCPLocalServerConfig` | `MCPHTTPServerConfig` / `MCPStdioServerConfig` (union `MCPServerConfig`) |
| `ping().timestamp: number` | `timestamp: string` (+ optional `protocolVersion`) |

Still present and unchanged: `createSession/resumeSession/listSessions/deleteSession/
getLastSessionId/listModels/getAuthStatus`, `sendAndWait`, `approveAll`, `reasoningEffort`
(`"low"|"medium"|"high"|"xhigh"`), `systemMessage`, `customAgents`, `agent`,
`skillDirectories`, `disabledSkills`, `mcpServers`, `provider` (BYOK), handler options
(`onPermissionRequest`, `onUserInputRequest`, `onElicitationRequest`), `streaming`.

## Import rules

- Most types export from the package root (`@github/copilot-sdk`), including
  `RuntimeConnection`, `SessionConfig`, `ResumeSessionConfig`, `ModelInfo`, `ProviderConfig`,
  `MCPServerConfig` variants, elicitation types.
- NOT exported from root (deep-import from `@github/copilot-sdk/dist/types` as type-only):
  `ReasoningEffort`, `UserInputHandler`, `UserInputRequest`, `UserInputResponse`.

## New in 1.x (feature surface)

- `reasoningSummary` (suppress/tune reasoning summaries), `contextTier:
  "default"|"long_context"`, `infiniteSessions` (auto context compaction, on by default:
  background at 0.80, blocking at 0.95), `hooks`, `commands` (slash commands),
  `pluginDirectories`, `mcpOAuthTokenStorage`, cloud/remote sessions (`enableRemoteSessions`,
  `cloud`, `remoteSession`), canvases & MCP Apps (experimental).
- Client `mode: "copilot-cli" | "empty"` — keep the default `"copilot-cli"` for this plugin.
- SDK package now depends on `@github/copilot` (bundled runtime) — irrelevant at Obsidian
  runtime since only `main.js` ships; the plugin resolves a system CLI (see
  `.docs/specs/runtime-manager.md`).

## Gotchas

- `SessionConfig.clientName` identifies the app (`obsidian-sidekick`).
- `reasoningEffort` only valid when `model.capabilities.supports.reasoningEffort`; supported
  levels in `model.supportedReasoningEfforts`.
- Event history from `getEvents()` includes `user.message`, `assistant.message`,
  `assistant.reasoning` among others; assistant messages may carry `reasoningText`.
