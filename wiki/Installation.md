# Installation

## Requirements

- **Obsidian Desktop 1.13.0 or newer** (Node.js 20.19+ runtime). Claude Synapse is desktop-only.
- **The Claude CLI.** Claude Synapse is a native [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
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

Claude Synapse finds the CLI automatically. If it's in an unusual place, set **Settings → Claude Synapse →
Claude → Claude CLI location**. The same page shows the resolved CLI path and version.

## 2. Install the plugin

- **Via BRAT (recommended while in beta).** Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat)
  community plugin, then add `https://github.com/NunoMotaRicardo/obsidian-synapse` as a beta
  plugin. BRAT downloads the plugin and keeps it updated.
- **Manually.** Download `main.js`, `styles.css`, and `manifest.json` from the
  [latest release](https://github.com/NunoMotaRicardo/obsidian-synapse/releases) into
  `<YourVault>/.obsidian/plugins/claude-synapse/`. Reload Obsidian and enable **Claude Synapse** in
  **Settings → Community plugins**.

## Upgrade from Synapse (pre-0.1.2)

Claude Synapse replaces the former **Synapse** plugin ID with `claude-synapse`. Before upgrading,
disable **Synapse** so both IDs are never active at once. Then close Obsidian and either let BRAT
install Claude Synapse, or move `<YourVault>/.obsidian/plugins/synapse/` to
`<YourVault>/.obsidian/plugins/claude-synapse/` before replacing its release files. This preserves
`data.json`; copy it to the new folder if your installer created a fresh folder instead.

Secure settings remain available because Claude Synapse keeps the same vault-scoped local-storage
keys as Synapse; it never scans or moves browser storage from another vault. Your `_synapse/`
customization folder, command IDs, view state, and CSS-based customizations remain unchanged.

## 3. Choose how Claude Synapse authenticates

Open **Settings → Claude Synapse → Claude**:

- **Claude subscription (OAuth)** uses the CLI's login.
- **Anthropic API key** is stored in vault-specific local storage, never in the plugin's data file.
- **Local agent endpoint** (optional) adds models from Ollama or another Messages-API endpoint to
  the model picker. Use **Test** to check the connection.

Details: [Configuration](Configuration.md).

## 4. First run: the starter kit

The first time Claude Synapse loads in a vault without a `_synapse/` folder, it creates one with the
[starter kit](Starter-Kit.md):

```text
_synapse/
  agents/
    writer.agent.md
  skills/
    synapse-config/   ← customize Claude Synapse from chat; setup workflow
    obsidian/         ← Obsidian Markdown, Bases, and CLI know-how
    think/            ← think an idea through before writing
    writing-style/    ← voice, tone, and AI-tell removal
```

If your vault already has `_synapse/`, or you deleted a starter file and want it back, go to
**Settings → Claude Synapse → Capabilities** and click **Initialize**. It adds any missing starter files
and never overwrites files you've changed.

## 5. Open Claude Synapse

Click the Claude Synapse icon in the ribbon, or run **Open chat** from the command palette. Then try:

> Set up my writing styles.

## Troubleshooting

- **No models, or "CLI not found".** Check **Settings → Claude Synapse → Claude** for the resolved CLI
  path and version, and set **Claude CLI location** if needed. Run `claude` in a terminal to
  confirm it works and that you're signed in.
- **A local endpoint doesn't answer.** Click **Test** under **Local agent endpoint**. The endpoint
  must speak the Anthropic Messages API; OpenAI-compatible-only servers need a gateway.
- **Errors.** Open the developer console (Ctrl+Shift+I) and look for lines prefixed `[synapse]`.

## Next

- [Using Claude Synapse](Using-Synapse.md): a tour of the panel and editor actions
- [Starter kit](Starter-Kit.md): what each bundled skill does
