# Spike: Claude Agent SDK runs inside Obsidian

**Date:** 2026-06-28
**Issue:** #2
**Verdict:** GO (with constraints)

## What was tested

The `@anthropic-ai/claude-agent-sdk` (0.3.195) was installed, bundled into the plugin via esbuild,
and wired as a command ("Test Claude Agent SDK") that sends a trivial prompt and streams the
response inside the running Obsidian instance.

## Findings

### SDK installs and bundles

- `npm install @anthropic-ai/claude-agent-sdk` succeeds.
- The SDK bundles cleanly into the single `main.js` via esbuild. No special externals or
  polyfills needed beyond what the plugin already uses.
- `tsc -noEmit -skipLibCheck` passes (skipLibCheck is already the project default).
- The SDK depends on `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, and `zod` (v4) as
  transitive dependencies. These all bundle without issue.

### CLI resolution

- The SDK spawns the `claude` CLI as a subprocess (similar to `@github/copilot-sdk` spawning
  `copilot`). The CLI must be installed on the system.
- The SDK has a `pathToClaudeCodeExecutable` option to specify the binary path explicitly.
  When omitted, the SDK auto-detects the system `claude` binary.
- The existing `runtimeManager.ts` pattern (resolve binary, build clean env) maps directly to
  the new SDK. A `resolveClaudeCliPath()` function can follow the same chain (global npm,
  PATH, platform-specific locations).

### API shape

- Primary entry point: `query({ prompt, options })` returns an `AsyncGenerator<SDKMessage>`.
- Streaming: `SDKPartialAssistantMessage` (type `'stream_event'`) carries
  `BetaRawMessageStreamEvent` with text deltas. Final `SDKAssistantMessage` (type `'assistant'`)
  carries the complete `BetaMessage`.
- No explicit "connect" / "session start" lifecycle needed — `query()` handles subprocess
  management internally.
- `startup()` is available for warm-start (pre-spawns the CLI process), useful for faster
  first-query latency.
- Tool control: `tools: []` disables all built-in tools; `permissionMode` controls what runs
  without prompting.

### Auth paths

Two auth paths are available:

1. **Anthropic API key:** Set `ANTHROPIC_API_KEY` in the `env` option. This is the simplest
   path and maps directly to the existing BYOK settings pattern in `src/settings.ts`.
2. **Claude subscription (OAuth):** The `claude` CLI manages its own OAuth login
   (`claude login`). The SDK picks this up automatically when the CLI is authenticated.
   The `AccountInfo` type exposes `tokenSource`, `apiKeySource`, and `apiProvider` fields.

Both paths work through the same `query()` call — no SDK-level auth configuration needed
beyond ensuring the CLI can authenticate.

### Constraints discovered

1. **Desktop-only:** The SDK spawns a subprocess, so mobile is ruled out (same as the Copilot
   SDK today). This is already the plugin's posture.
2. **CLI must be pre-installed:** The SDK does not bundle the `claude` CLI. Users need
   `npm install -g @anthropic-ai/claude-code` or equivalent. Same pattern as the Copilot CLI
   today — guidance in settings UI and README.
3. **Process lifecycle:** The SDK manages the subprocess internally. `startup()` can pre-warm
   it, and `AbortController` in options handles cancellation. The plugin's `onunload` should
   abort any active queries.
4. **Bundle size:** The SDK and its transitive dependencies add to `main.js`. In practice this
   is acceptable — the bundle was already large from the Copilot SDK.
5. **No JSON-RPC protocol version negotiation:** Unlike the Copilot SDK (which has explicit
   protocol version checks), the Claude Agent SDK version must match the CLI version. The SDK
   throws if the CLI is too old.

## Architecture recommendation

Replace `CopilotService` in `src/copilot.ts` with an `AgentService` that wraps `query()` /
`startup()`. The service should:

- Resolve the `claude` CLI binary (extend `runtimeManager.ts` or create `claudeRuntime.ts`).
- Own the `AbortController` for active queries.
- Expose a streaming chat method that yields text deltas (matching the current
  `CopilotService.chat()` shape).
- Handle auth via the `env` option (`ANTHROPIC_API_KEY` from settings) or CLI-managed OAuth.
- Register cleanup in `onunload`.

The migration can be incremental: `AgentService` can coexist with `CopilotService` during
the transition, selected by a settings toggle.
