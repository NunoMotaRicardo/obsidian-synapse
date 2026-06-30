# Gemini context

This project is **Claude-first**: the canonical context, conventions, and architecture notes live
in `CLAUDE.md`. Import them so Gemini works from the same single source (no duplicated copy to
drift):

@./CLAUDE.md

## Gemini-specific notes

- **Custom commands** live in `.gemini/commands/` and inject the canonical playbooks from
  `.claude/skills/` via `@{...}` file injection — so there is one source of truth, not a copy:
  - `/synapse:build` → `.gemini/commands/synapse/build.toml`
  - `/deploy-test` → `.gemini/commands/deploy-test.toml`
  - `/release` → `.gemini/commands/release.toml`
  Run `/commands reload` after editing them.
- **Subagents:** the bespoke implementation agent `synapse-coder` is defined for Claude Code at
  `.claude/agents/synapse-coder.md`. Gemini supports subagents too (`.gemini/agents/*.md`); mirror it
  there if you want the same delegation in Gemini. Not maintained by default (Claude-first).
- Everything else (the `synapse-analyst`, `synapse-technical-planner`, `synapse-reviewer` playbooks) is a
  skill — read the corresponding `.claude/skills/<name>/SKILL.md` and follow it inline.
