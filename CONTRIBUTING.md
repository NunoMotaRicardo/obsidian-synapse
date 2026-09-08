# Contributing to Synapse

Thanks for your interest in improving Synapse. This is a desktop-only Obsidian plugin, built with
TypeScript and bundled with esbuild.

## Setup

```
npm install
```

CI runs the build and lint against Node 22.x and 26.x (see `.github/workflows/lint.yml`). Use
either for local development.

## Scripts

- `npm run build` — type-checks with `tsc -noEmit -skipLibCheck` and produces the production
  bundle via esbuild. This is the same check CI runs; it must be clean (strict TypeScript, no
  errors) before you open a PR.
- `npm run lint` — runs eslint (including `eslint-plugin-obsidianmd`). Must be clean before you
  open a PR.
- `npm run test` — runs the vitest suite.

`npm run dev` starts esbuild in watch mode for local iteration.

## Code conventions

- Tabs for indentation, single quotes, no trailing-semicolon omission — match the style already in
  the file you're editing.
- All Claude Agent SDK access goes through the single service in `src/agentService.ts`. Other
  modules should only import SDK types via its re-exports, not talk to the SDK directly.
- `src/main.ts` stays lifecycle-only. UI lives in `src/view/*` and `src/modals/*`, editor features
  in `src/editor/*`, vault config writing in `src/configWriter.ts`, session config assembly in
  `src/view/sessionConfig.ts`, settings and secrets in `src/settings.ts`.
- Secrets (tokens, API keys) never go in `data.json` — use the existing localStorage-backed paths
  in `src/settings.ts`.
- Register all listeners, intervals, and timers through Obsidian's `register*` helpers so nothing
  leaks across plugin reload/unload.
- Obsidian UI copy: sentence case, **bold** for literal labels, arrows for navigation (e.g.
  **Settings → Community plugins**).
- Don't rename command IDs, settings keys, or vault-local customization field names without a
  migration path.

## Documentation

- If your change alters a module's behavior, update the matching `specs/<module>.md` **in
  the same pull request**. Specs are the source of truth for how each module works; a PR that
  changes behavior without updating its spec will not be merged as-is.
- If your change affects setup, providers, or customization behavior, update `README.md` too.

## What never gets committed

- `main.js` (and other build output) is never committed — it's produced by `npm run build` /
  `npm run dev` and is git-ignored. Only source files under `src/` are tracked.
- Secrets of any kind.

## Pull requests

- Keep PRs focused on one change; unrelated fixes belong in their own PR.
- Fill in the pull request template — it asks for what changed, why, and how you verified it.
- Make sure `npm run build`, `npm run lint`, and `npm run test` all pass locally before you push.

## Reporting security issues

Please do not open a public issue for a security vulnerability — see `SECURITY.md` for how to
report it privately.
