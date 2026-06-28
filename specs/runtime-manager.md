# runtime-manager

Source: `src/runtimeManager.ts` — `resolveDefaultCliPath`, `getCliVersion`, `cleanEnv`.

Status: **complete** — rebased to resolve `claude` binary across chain, version/protocol check + install guidance (#4).

Tracked by #4.

## Module API (`src/runtimeManager.ts`)

- `resolveDefaultCliPath(): Promise<ResolvedCliPath>` — walks the resolution chain below
  (excluding the explicit settings path, which the caller short-circuits) and returns
  `{path, source}` where `source` is one of `'global-npm' | 'os-links' | 'sdk-fallback'`.
- `ResolvedCliPath = {path: string; source: CliPathSource; version?: string; protocolVersion?: string}`
  where `CliPathSource` also includes `'settings'` (used by `AgentService` when an explicit `claudeLocation` is set).
- `getCliVersion(binaryPath: string): Promise<{version: string; protocolVersion?: string}>` — spawns `binaryPath --version` to extract CLI version and protocol version.
- `cleanEnv(): Record<string, string>` — allowlisted subprocess environment.

`AgentService` (`src/copilot.ts`) is the only `@anthropic-ai/claude-agent-sdk` consumer: it calls
`resolveDefaultCliPath` when no explicit `claudeLocation` is set, caches the
`ResolvedCliPath`, passes `pathToClaudeCodeExecutable` to query options, and exposes `resolveCliPath(): Promise<ResolvedCliPath>` for the settings UI.

## Responsibilities

1. **Resolve** the Claude CLI binary, in priority order:
   1. Explicit path from settings (`claudeLocation`, when non-empty). Handled in `AgentService.resolveCliPath()`.
   2. Global npm prefix: `%APPDATA%\npm\node_modules\@anthropic-ai\claude-agent-sdk-<platform>-<arch>\claude(.exe)`, global wrappers, or `__dirname/node_modules`.
   3. OS links: WinGet links (`%LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe`), `~/.claude/bin/claude`, `/usr/local/bin/claude`, `/usr/bin/claude`, `~/.local/bin/claude`.
   4. SDK package binary fallback (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude(.exe)` under `__dirname/node_modules`).

2. **Version / protocol check** (#4):
   - After connect, `AgentService` calls `getCliVersion(resolved.path)` fire-and-forget and fires its `onVersionInfo` constructor callback with `{version, protocolVersion, path}`.
   - `main.ts` wires the callback to log `Claude Brain: Claude CLI v%s (protocol %s) at %s` to console.
   - Settings display: the resolved binary path line in Settings → Claude shows version info after connect, e.g. `Resolved CLI: C:\...\claude.exe (from global npm install) — v2.1.195, protocol 1`.

3. **Install guidance** (#4):
   - When `initCopilot()` + `ensureConnected()` fails because no CLI was found, `main.ts` shows a platform-specific Obsidian `Notice` (long duration, 30s):
     - Windows: "No Claude CLI found. Install with `winget install Anthropic.ClaudeCode or npm install -g @anthropic-ai/claude-code`, then restart the plugin."
     - macOS/Linux: "No Claude CLI found. Install with `npm install -g @anthropic-ai/claude-code`, then restart the plugin."
   - The Notice lives in `main.ts`, keep UI dependencies out of `AgentService`.

## Settings surface

- The Claude tab shows a setting for **Claude CLI location** (`claudeLocation`) and a read-only line with the **resolved binary path**, which step of the chain it came from, and version/protocol info.

## Invariants

- runtime-manager touches only `node:*` builtins and Obsidian APIs — it does **not** import `@anthropic-ai/claude-agent-sdk`. `AgentService` stays the sole SDK consumer and calls into runtime-manager for path resolution.
- Desktop-only: Node builtins are lazy-loaded so the module stays import-safe on mobile.

## Non-goals

- Auto-updating the system CLI.
- Mobile support (plugin is desktop-only; runtime spawn requires Node).
