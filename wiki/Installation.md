# Installation

> [!IMPORTANT]
> Synapse requires Obsidian Desktop 1.13.0 or newer (Node.js 20.19+ runtime) and talks to the Claude CLI via `@anthropic-ai/claude-agent-sdk`.

1. **Install** — Either:
   - **Via BRAT** — Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin, then add `https://github.com/NunoMotaRicardo/obsidian-synapse` as a beta plugin. BRAT handles downloads and updates automatically.
   - **Manual** — Download `main.js`, `styles.css`, and `manifest.json` from the latest release into `<YourVault>/.obsidian/plugins/synapse/`. Then reload Obsidian and enable **Synapse** in **Settings → Community plugins**.
2. **Configure API / CLI** — Open **Settings → Synapse**. Configure your **Anthropic API Key** or use **OAuth** (Claude Subscription), or configure a local model provider like **Ollama**.
3. **Initialize** — Under **Synapse settings** (Capabilities tab), click **Initialize** to scaffold the config structure under the hardcoded `_synapse/` folder:
   ```
   _synapse/
     agents/    ← *.md agent/persona files
     skills/    ← subfolder per skill with SKILL.md
     .mcp.json  ← MCP server config
   ```
4. **Open Synapse** — Click the **brain** icon in the ribbon, or run **Open Synapse** from the command palette.

You're ready. Start chatting, or see [Configuration](Configuration.md) and [Customization](Customization.md) to unlock every feature.
