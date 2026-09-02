# Synapse repository instructions

This repository is the source for Synapse, an Obsidian Community Plugin that embeds a Claude-native AI assistant (with support for agents, skills, MCP tool servers, and local models).

## Core expectations

- Treat this as an Obsidian plugin first. Prefer Obsidian APIs, existing DOM patterns, and small focused modules over framework-heavy solutions.
- Use the existing npm toolchain. Build with `npm run build`, lint with `npm run lint`, and use `npm run dev` for watch mode.
- Keep runtime dependencies minimal and compatible with the Obsidian plugin environment.
- Do not commit generated artifacts or assume `main.js` is the source of truth. Source lives under `src/`.

## Architectural boundaries

- Keep `src/main.ts` small and focused on plugin lifecycle, settings bootstrapping, view registration, and top-level command wiring.
- Put Claude Agent SDK interactions, CLI binary resolution, session bridge behavior, and environment configuration in `src/agentService.ts` (`AgentService`) and `src/runtimeManager.ts`.
- Keep vault-local customization writers in `src/configWriter.ts`.
- Keep translation from Obsidian state into SDK session config, attachments, and model details in `src/view/sessionConfig.ts`.
- Keep persisted plugin settings and secret handling in `src/settings.ts`.
- Prefer adding focused modules under `src/view/`, `src/modals/`, `src/editor/`, or `src/bots/` instead of growing monolithic files.

## Synapse customization model

- Synapse runtime customizations are vault-local and rooted at the hardcoded `_synapse/` directory.
- Preserve the layout and semantics of customization artifacts: `agents/*.md` (subagents), `skills/*/SKILL.md` (skills), and `.mcp.json` (MCP servers config).
- Do not imply that VS Code or Claude customization files (such as `.github/instructions.md`) are automatically loaded by the plugin runtime. They are repository authoring aids unless the code explicitly imports or translates them.

## Settings, safety, and privacy

- Keep defaults sensible and stable. Avoid renaming command ids, settings keys, or configuration fields without a migration path.
- Persist secrets through the existing secure local-storage helpers instead of writing tokens or API keys into plugin data.
- Default to local-first behavior. New network access, remote execution, or third-party integrations must be user-visible, justified, and documented.
- Respect Obsidian plugin cleanup requirements. Use `register*` helpers and avoid leaking listeners, intervals, or view state across reloads.

## UI and editor work

- Match the current Obsidian-native UI style instead of introducing a separate component framework.
- Keep user-facing copy concise, clear, and in sentence case.
- For editor features, rely on Obsidian's CodeMirror runtime and preserve the externalized CodeMirror dependency model.

## Documentation expectations

- Update `README.md` or the relevant docs file when a change affects setup, configuration, supported models, customization behavior, or user workflows.
- Clearly distinguish between repository/editor customization files and Synapse's own vault-local runtime configuration.
