---
name: claude-agent-sdk-reference
description: Reference for the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) that this plugin is migrating to. Use when working on the SDK service (src/copilot.ts → AgentService), sessions, models, auth, tools/MCP, hooks, or any Agent-SDK change.
---

# claude-agent-sdk-reference

The plugin is migrating from `@github/copilot-sdk` to the **Claude Agent SDK**. Decision + plan:
`wiki/decisions/2026-06-28-claude-agent-sdk-migration.md` (epic + issues on
`NunoMotaRicardo/obsidian-claude-brain`).

## What it is
- TypeScript package: `@anthropic-ai/claude-agent-sdk`. Like the Copilot SDK, it drives a CLI
  runtime (the `claude` binary) as a subprocess — so `runtime-manager` resolves that binary rather
  than disappearing (runtime-manager rebase issue).
- Auth: Claude subscription (OAuth) **or** Anthropic API key — user-selectable.
- Native primitives the migration leans on: subagents, skills, hooks, MCP tools, sessions.

## Authoritative sources (read before guessing API shapes)
- Official docs: https://code.claude.com/docs/en/agent-sdk/overview
- Local type definitions once installed: `node_modules/@anthropic-ai/claude-agent-sdk/**/*.d.ts`
  — read these for exact types (the same discipline copilot-sdk-reference applied to the Copilot
  SDK types).
- The `claude-api` skill for Claude model ids, params, pricing, tool use, MCP.

## Architecture rule (unchanged by the migration)
All SDK access goes through the single service in `src/copilot.ts` (being renamed `AgentService`).
Other modules import SDK types only via its re-exports.

> API specifics — client construction, session options, streaming events, tool/MCP/hook wiring —
> are confirmed during the feasibility spike and engine-swap issues. Capture verified shapes here
> as they are validated against the installed `.d.ts` types. **Do not invent signatures.**
