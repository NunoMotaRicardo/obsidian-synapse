/**
 * Shared lazy-load shim for Node built-ins.
 *
 * In Obsidian's Electron renderer `window.require` is the CommonJS `require` the bundle
 * itself is loaded through (available at runtime in the esbuild CJS bundle), so it resolves
 * `node:*` modules synchronously — cheaper and more reliable than a dynamic `import()`
 * chunk in the renderer. It is unavailable outside Electron's renderer (e.g. under vitest's
 * node environment), which is why the guard, not a bare reference.
 *
 * Call sites keep their own per-module casts (`as typeof import('node:…')`) and their
 * `?? await import('node:…')` fallback for the non-Electron case — only the shim const is
 * shared here, previously duplicated in `agentService.ts`, `runtimeManager.ts` and
 * `view/sessionConfig.ts`.
 */
export const nodeRequire = typeof window.require === 'function' ? window.require : undefined;
