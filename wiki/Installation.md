# Installation

## Requirements

- **Obsidian Desktop 1.13.0 or newer** (Node.js 20.19+ runtime). Synapse is desktop-only.
- **The Claude CLI.** Synapse is a native [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
  plugin. It doesn't call a model API itself; it drives the `claude` CLI installed on your
  machine, so every conversation runs on the same agent loop as Claude Code. The CLI is required
  for Claude models **and** for local models.
- **One way to run a model:**
  - a **Claude subscription** (sign in through the CLI), or
  - an **Anthropic API key**, or
  - **Ollama v0.14.0+** or another endpoint that speaks the **Anthropic Messages API**, for local or
    self-hosted models. See [Local models with Ollama](Local-Models-Ollama.md).

## 1. Install the Claude CLI

Follow the official [Claude Code setup guide](https://code.claude.com/docs/en/setup). Then run
`claude` once in a terminal and sign in if you use a Claude subscription.

Synapse finds the CLI automatically. If it's in an unusual place, set **Settings → Synapse →
Claude → Claude CLI location**. The same page shows the resolved CLI path and version.

## 2. Install the plugin

- **Via BRAT (recommended while in beta).** Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat)
  community plugin, then add `https://github.com/NunoMotaRicardo/obsidian-synapse` as a beta
  plugin. BRAT downloads the plugin and keeps it updated.
- **Manually.** Download `main.js`, `styles.css`, and `manifest.json` from the
  [latest release](https://github.com/NunoMotaRicardo/obsidian-synapse/releases) into
  `<YourVault>/.obsidian/plugins/synapse/`. Reload Obsidian and enable **Synapse** in
  **Settings → Community plugins**.

## 3. Choose how Synapse authenticates

Open **Settings → Synapse → Claude**:

- **Claude subscription (OAuth)** uses the CLI's login.
- **Anthropic API key** is stored in vault-specific local storage, never in the plugin's data file.
- **Local agent endpoint** (optional) adds models from Ollama or another Messages-API endpoint to
  the model picker. Use **Test** to check the connection.

Details: [Configuration](Configuration.md).

## 4. First run: the starter kit

The first time Synapse loads in a vault without a `_synapse/` folder, it creates one with the
[starter kit](Starter-Kit.md):

```text
_synapse/
  agents/
    writer.agent.md
  skills/
    synapse-config/   ← customize Synapse from chat; setup workflow
    obsidian/         ← Obsidian Markdown, Bases, and CLI know-how
    think/            ← think an idea through before writing
    writing-style/    ← voice, tone, and AI-tell removal
```

If your vault already has `_synapse/`, or you deleted a starter file and want it back, go to
**Settings → Synapse → Capabilities** and click **Initialize**. It adds any missing starter files
and never overwrites files you've changed.

## 5. Open Synapse

Click the Synapse icon in the ribbon, or run **Open chat** from the command palette. Then try:

> Set up my writing styles.

## Troubleshooting

- **No models, or "CLI not found".** Check **Settings → Synapse → Claude** for the resolved CLI
  path and version, and set **Claude CLI location** if needed. Run `claude` in a terminal to
  confirm it works and that you're signed in.
- **A local endpoint doesn't answer.** Click **Test** under **Local agent endpoint**. The endpoint
  must speak the Anthropic Messages API; OpenAI-compatible-only servers need a gateway.
- **Errors.** Open the developer console (Ctrl+Shift+I) and look for lines prefixed `[synapse]`.

## Next

- [Using Synapse](Using-Synapse.md): a tour of the panel and editor actions
- [Starter kit](Starter-Kit.md): what each bundled skill does
