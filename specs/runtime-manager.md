# runtime-manager

Source: `src/runtimeManager.ts` — `resolveDefaultCliPath`, `cleanEnv`.

Status: **complete** — extraction + resolution chain shipped (#13). Version/protocol check +
install guidance + `plugin-managed` removal shipped (#15). Download-fallback (#14) was dropped
(closed as won't-do) — the plugin assumes user-installed CLI.

Tracked by #2, sliced into: extraction + resolution chain (#13, done), version/protocol check
+ install guidance + plugin-managed removal (#15, done).

## Module API (`src/runtimeManager.ts`)

- `resolveDefaultCliPath(): Promise<ResolvedCliPath>` — walks the resolution chain below
  (excluding the explicit settings path, which the caller short-circuits) and returns
  `{path, source}` where `source` is one of `'global-npm' | 'winget' | 'js-fallback'`.
- `ResolvedCliPath = {path: string; source: CliPathSource}` where `CliPathSource` also includes
  `'settings'` (used by `CopilotService` when an explicit `copilotLocation` is set).
- `cleanEnv(): Record<string, string>` — allowlisted subprocess environment (unchanged).

`CopilotService` (`src/copilot.ts`) is the only `@github/copilot-sdk` consumer: it calls
`resolveDefaultCliPath` when no explicit `copilotLocation` is set, caches the
`ResolvedCliPath`, and exposes `resolveCliPath(): Promise<ResolvedCliPath | undefined>`
(undefined in remote mode) for the settings UI.

## Responsibilities

1. **Resolve** the Copilot CLI binary, in priority order:
   1. Explicit path from settings (`copilotLocation`, when non-empty). Handled today in
      `CopilotService.createClient()`; runtime-manager owns the rest of the chain.
   2. Global npm prefix: `%APPDATA%\npm\node_modules\@github\copilot-<platform>-<arch>\copilot(.exe)`
      (also nested under `@github/copilot/node_modules/...`), plus a `__dirname/node_modules`
      search root (vestigial in a bundled plugin, but preserved).
   3. WinGet Links (Windows only):
      `%LOCALAPPDATA%\Microsoft\WinGet\Links\copilot.exe`.
   4. JS CLI entry point fallback (`@github/copilot/index.js` under `__dirname`); failing
      that, an actionable error with platform-specific install instructions.

2. **Version / protocol check** (#15):
   - After connect, `CopilotService` calls `client.getStatus()` fire-and-forget (try/catch,
     does not block connect) and fires its `onVersionInfo` constructor callback with
     `{version, protocolVersion}` + the resolved path.
   - `main.ts` wires the callback to log `Sidekick: Copilot CLI v%s (protocol %d)` to console.
   - Settings display: the resolved binary path line shows version info after connect, e.g.
     `C:\...\copilot.exe (from global npm install) — v1.0.63, protocol 3`.
   - The SDK already checks protocol mismatch during `client.start()` and throws — no separate
     mismatch Notice on successful connect. The value of `getStatus()` is informational
     (logging + settings display).

3. **Install guidance** (#15):
   - When `initCopilot()` + `ensureConnected()` fails because no CLI was found (resolution
     chain exhausted, or `start()` throws a CLI-not-found error), `main.ts` shows a
     platform-specific Obsidian `Notice` (long duration, ~30s):
     - Windows: "No Copilot CLI found. Install with `winget install GitHub.CopilotCLI` or
       `npm install -g @github/copilot`, then restart the plugin."
     - macOS/Linux: "No Copilot CLI found. Install with `npm install -g @github/copilot`,
       then restart the plugin."
   - The Notice lives in `main.ts`, not inside `CopilotService` — keep UI dependencies out of
     the service.

## Settings surface

- The Copilot client tab, local mode, shows a read-only line with the **resolved binary path**
  and which step of the chain it came from. After connect, version and protocol info is
  appended (e.g. `— v1.0.63, protocol 3`).

## Invariants

- runtime-manager touches only `node:*` builtins and Obsidian APIs — it does **not** import
  `@github/copilot-sdk`. `CopilotService` stays the sole SDK consumer and calls into
  runtime-manager for path resolution.
- Desktop-only: Node builtins are lazy-loaded so the module stays import-safe on mobile.

## Non-goals

- Auto-updating the system CLI.
- Mobile support (plugin is desktop-only; runtime spawn requires Node).
- Downloading/managing CLI binaries (dropped with #14 — the plugin assumes user-installed CLI).
