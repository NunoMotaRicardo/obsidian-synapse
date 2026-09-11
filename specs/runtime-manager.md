# runtime-manager

Source: `src/runtimeManager.ts` — `resolveDefaultCliPath`, `getCliVersion`, `cleanEnv`,
`BUNDLED_SDK_VERSION`, `getVersionSkewWarning`.

## Module API (`src/runtimeManager.ts`)

- `resolveDefaultCliPath(): Promise<ResolvedCliPath>` — walks the resolution chain below
  (excluding the explicit settings path, which the caller short-circuits) and returns
  `{path, source}` where `source` is one of `'global-npm' | 'os-links' | 'sdk-fallback'`.
- `ResolvedCliPath = {path: string; source: CliPathSource; version?: string}`
  where `CliPathSource` also includes `'settings'` (used by `AgentService` when an explicit `claudeLocation` is set).
- `getCliVersion(binaryPath: string): Promise<{version: string}>` — validates `binaryPath` (absolute, allowlisted extension) then spawns `binaryPath --version` to extract the CLI version.
- `cleanEnv(): Record<string, string>` — allowlisted subprocess environment.
- `BUNDLED_SDK_VERSION: string` — the `@anthropic-ai/claude-agent-sdk` version this build was bundled
  against. Baked in at build time by `esbuild.config.mjs` (reads the installed package's
  `package.json` and injects it via an esbuild `define`, since node_modules never ships with the
  deployed plugin — only `main.js`/`manifest.json`/`styles.css` are copied to the vault). Resolves
  to `'unknown'` outside the esbuild bundle (e.g. under vitest).
- `getVersionSkewWarning(cliVersion: string, sdkVersion = BUNDLED_SDK_VERSION): string | null` —
  compares the CLI's and SDK's trailing build number (e.g. `2.1.258` vs `0.3.258` → both `258`;
  the `claude` CLI and the JS SDK ship from the same pipeline and share this trailing number even
  though their major.minor lines differ) and returns a human-readable, **non-blocking** warning
  when they diverge, or `null` when in sync / unparseable. A newer CLI is normal (it self-updates
  independently of the plugin) — this is purely informational, never a hard failure.

`AgentService` (`src/agentService.ts`) is the only `@anthropic-ai/claude-agent-sdk` consumer: it calls
`resolveDefaultCliPath` when no explicit `claudeLocation` is set, caches the
`ResolvedCliPath`, performs an `fs.access` check to throw early when the binary is missing,
passes `pathToClaudeCodeExecutable` to query options, and exposes:
- `resolveCliPath(): Promise<ResolvedCliPath>` — returns the cached resolved path (settings override or auto-detected).
- `getVersionInfo(): Promise<ResolvedCliPath>` — awaits `getCliVersion()` and returns the resolved path with version fields populated; used by the settings UI instead of the fire-and-forget path.

## Responsibilities

1. **Resolve** the Claude CLI binary, in priority order:
   1. Explicit path from settings (`claudeLocation`, when non-empty). Handled in `AgentService.resolveCliPath()`.
   2. Global npm prefix: native package binary (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude(.exe)`, also checked nested under `@anthropic-ai/claude-agent-sdk`'s and `@anthropic-ai/claude-code`'s own `node_modules`, plus `@anthropic-ai/claude-code/bin/claude(.exe)`) under `%APPDATA%\npm\node_modules` (Windows), or on other platforms `~/.nvm/versions/node/current/lib/node_modules`, `/usr/local/lib/node_modules`, `/opt/homebrew/lib/node_modules` — and `__dirname/node_modules` on every platform. Note: `.cmd` wrapper files (created by npm for global installs) are **not** used as binary candidates — they cannot be passed to `execFile()` or to `pathToClaudeCodeExecutable`.
   3. OS links: WinGet links (`%LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe`), `~/.claude/bin/claude`, `/usr/local/bin/claude`, `/usr/bin/claude`, `~/.local/bin/claude`.
   4. SDK package binary fallback — both nested and flat paths under `__dirname/node_modules` are existence-checked. Returns the canonical expected path if neither exists (so `ensureConnected()` can surface a clear error).

2. **Version check**:
   - After connect, `AgentService` calls `getCliVersion(resolved.path)` fire-and-forget and fires its `onVersionInfo` constructor callback with `{version, path}`.
   - `main.ts` wires the callback to `debugTrace('Synapse: Claude CLI v%s at %s')` — only printed to console when debug mode is on.
   - Settings display: the resolved binary path line in Settings → Claude shows version info after connect, e.g. `Resolved CLI: C:\...\claude.exe (from global npm install) — v2.1.258 (SDK v0.3.258)`.

3. **CLI/SDK version-skew detection**:
   - The `claude` CLI (`@anthropic-ai/claude-code`) self-updates independently of the plugin's
     bundled `@anthropic-ai/claude-agent-sdk`, so skew is the steady state, not an error condition.
   - Settings → Claude renders a second, non-blocking warning line directly under the resolved
     CLI line (`getVersionSkewWarning()`) whenever the CLI's and SDK's trailing build numbers
     diverge — e.g. `⚠ CLI (2.1.320) is 62 releases ahead of the bundled SDK (0.3.258)...`. In sync,
     no line is rendered. This never blocks connecting or using the plugin.

4. **Install guidance**:
   - When `initAgentService()` + `ensureConnected()` fails because no CLI was found, `main.ts` shows a platform-specific Obsidian `Notice` (long duration, 30s):
     - Windows: "No Claude CLI found. Install with `winget install Anthropic.ClaudeCode or npm install -g @anthropic-ai/claude-code`, then restart the plugin."
     - macOS/Linux: "No Claude CLI found. Install with `npm install -g @anthropic-ai/claude-code`, then restart the plugin."
   - The Notice lives in `main.ts`, keep UI dependencies out of `AgentService`.

## Settings surface

- The Claude tab shows a setting for **Claude CLI location** (`claudeLocation`) and a read-only line
  with the **resolved binary path**, which step of the chain it came from, the CLI version, and the
  bundled SDK version — plus a second, non-blocking warning line when the two have drifted apart
  (see "CLI/SDK version-skew detection" above).

## Invariants

- runtime-manager touches only `node:*` builtins and Obsidian APIs — it does **not** import `@anthropic-ai/claude-agent-sdk`. `AgentService` stays the sole SDK consumer and calls into runtime-manager for path resolution.
- Desktop-only: Node builtins are lazy-loaded so the module stays import-safe on mobile.

## Non-goals

- Auto-updating the system CLI.
- Mobile support (plugin is desktop-only; runtime spawn requires Node).
