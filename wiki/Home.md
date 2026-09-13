# Synapse wiki

![Synapse](images/synapse_banner1.png)

**Claude, working inside your vault.** Synapse turns Obsidian into a workspace for the Claude
agent. It reads and writes your notes, follows your links, runs tools, remembers every
conversation, and learns to write in your voice.

**Claude and local models in one agent.** Use Claude for the hardest work and run models on your
own machine with **Ollama** when privacy or cost matters. Both run through the same Claude Agent
SDK, so local models get the same sessions, skills, subagents, and MCP tools as Claude. Switch
models per conversation or bind one to each agent. See
[Local models with Ollama](Local-Models-Ollama.md).

![Synapse chat panel open beside a note in Obsidian](images/synapse-chat.png)

## What makes it different

- **A real agent, not a chat box.** Synapse is a native Claude Agent SDK plugin. It runs on the
  Claude CLI with the same agent loop as Claude Code: sessions, subagents, skills, MCP tools, and
  permission controls.
- **Your model, your call.** Use your Claude subscription or an API key, Ollama's local or cloud
  models, or any other endpoint that speaks the Anthropic Messages API.
- **Customized by conversation.** Describe the assistant you want and the `synapse-config` skill
  writes the agent or skill for you, after you approve it.
- **Your voice, not an AI's.** The setup workflow builds writing styles from documents you wrote,
  so drafts and rewrites sound like you.
- **Everything is a note.** Agents, skills, and tool configuration are plain files in `_synapse/`,
  so you can read, edit, sync, and version them with the rest of your vault.
- **Everywhere you work.** Use the side panel, right-click actions on text, notes, and folders,
  vault search, or a Telegram bot on your phone.

New here? Start with **[Installation](Installation.md)**, then open Synapse and type *"Set up my
writing styles."*

## Getting started

- [Installation](Installation.md) — requirements (including the Claude CLI), BRAT or manual install, and first run
- [Using Synapse](Using-Synapse.md) — the chat panel, search, sessions, and editor and file actions
- [Starter kit](Starter-Kit.md) — the bundled Writer agent and the `synapse-config`, `obsidian`, `think`, and `writing-style` skills

## Setup and customization

- [Configuration](Configuration.md) — authentication, feature agents, capabilities, tools, and bots
- [Customization](Customization.md) — agents, skills, MCP servers, and vault settings under `_synapse/`
- [Telegram bot](Telegram-Bot.md) — chat with your agents from anywhere

## Local models

- [Local-Models-Ollama](Local-Models-Ollama.md) — configuring the local agent endpoint, Ollama Cloud models, and context-window tuning

## Credits

Synapse began as an adaptation of [obsidian-sidekick](https://github.com/vieiraae/obsidian-sidekick) by
[Alexandre Vieira](https://github.com/vieiraae), built on the GitHub Copilot SDK. Synapse rebuilt
it on the Claude Agent SDK.

## About this wiki

This wiki is generated from the `wiki/` directory in the [main repo](https://github.com/NunoMotaRicardo/obsidian-synapse) and synced here on every push to `main`. Edits made through this Wiki UI are not preserved — make changes to `wiki/` in the repo instead.

## Something missing?

[Open an issue](https://github.com/NunoMotaRicardo/obsidian-synapse/issues) — feedback and bug reports are welcome.
