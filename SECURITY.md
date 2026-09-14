# Security policy

Claude Synapse (`claude-synapse`) is a desktop Obsidian plugin that runs a Claude-native agent locally. It intentionally gives an agent access to a selected working directory and optional tools. Read the complete [Community directory disclosure](COMMUNITY_DISCLOSURES.md) before enabling integrations.

## Supported versions

The latest release on the repository's default distribution channels receives security fixes. Older versions are not guaranteed to receive backports. Claude Synapse is intended for Community-directory distribution; manual installation and development builds are also possible. See the [releases](https://github.com/NunoMotaRicardo/obsidian-synapse/releases) page for the current artifacts.

## Reporting a vulnerability

Please do not open a public GitHub issue for a security vulnerability. Use GitHub's private vulnerability reporting for this repository (**Security → Report a vulnerability**), or contact [@NunoMotaRicardo](https://github.com/NunoMotaRicardo) if that flow is unavailable.

## Threat model

### Agent, CLI, and filesystem access

The Claude Agent SDK starts the separately installed `claude` CLI as a local subprocess for agent queries. The CLI and enabled tools may autonomously read content from any accessible file in the selected working directory, not only explicitly selected text. The normal directory is the vault, but the user can select another directory; MCP configuration, additional SDK locations, and explicitly selected attachments can grant access outside it. Providers and tools may read content from any of those accessible locations. API keys and bot tokens are kept out of `data.json`, but local-storage-backed values are not necessarily encrypted at rest.

### Tool approval and unattended execution

Tool approval defaults to **Ask**. **Allow** or a bypass/plan mode removes some or all approval prompts for the applicable desktop feature. The optional Telegram runner intentionally uses bypass permissions: every allowed Telegram user can cause agent reads, writes, command/tool calls, and MCP actions against the vault without someone at the keyboard. Telegram downloads persist under `_synapse/bot-attachments`, may sync with the vault, and are not automatically deleted. Keep the numeric allowlist short and treat its members as trusted operators.

### Vault-local MCP configuration

`_synapse/.mcp.json` is consumed by the Claude Agent SDK. Stdio entries can start configured local child processes; HTTP/SSE entries can contact their configured remote services. An MCP server is executable configuration, not harmless data: it can read/write outside the vault, run commands, or exfiltrate context. Review synced or shared vault configuration before opening it.

### Provider privacy and network exposure

Claude Synapse has no maintainer telemetry, analytics, crash reporting, or advertising. Depending on settings, prompts, selected vault context, attachments, tool results, and conversation content may be sent through the Claude CLI to Anthropic, to a user-configured Anthropic Messages API-compatible endpoint (including Ollama), to Telegram, or to an MCP service. Those providers control their own retention, logging, telemetry, and training policies. See [COMMUNITY_DISCLOSURES.md](COMMUNITY_DISCLOSURES.md) for destinations and data-flow details.

## Publication and attribution status

The repository is open source and preserves Apache License 2.0 attribution for portions derived from [obsidian-sidekick](https://github.com/vieiraae/obsidian-sidekick) in [NOTICE](NOTICE) and [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt). This policy does not claim upstream or Obsidian approval. Submission is blocked until publicly verifiable written approval from the upstream maintainer is linked, or the documented unreachable/inactive-author policy process is satisfied and its evidence is linked.
