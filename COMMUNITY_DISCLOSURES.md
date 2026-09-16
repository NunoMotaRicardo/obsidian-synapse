# Community directory disclosures

This page is the publication disclosure for **Claude Synapse** (`claude-synapse`). It describes what the plugin can access and which services it can contact. Claude Synapse is desktop-only and does not provide a hosted service.

## Accounts, payments, and providers

- **Claude:** Claude Synapse requires the separately installed Claude CLI, even for local-model use. To use Anthropic-hosted Claude, the user signs in to the CLI with a Claude subscription (OAuth) or configures an Anthropic API key. A subscription or API usage may incur charges under Anthropic's terms; Claude Synapse does not sell a subscription and does not process payments.
- **Anthropic-compatible endpoints:** Users may configure any endpoint that speaks the Anthropic Messages API. The endpoint URL and optional key are user supplied. The endpoint receives prompts, selected vault context, attachments, tool results, and model responses for that session. Endpoint operators—not Claude Synapse—control retention, logging, training, and charges. This includes a remote proxy or a self-hosted service.
- **Ollama:** Ollama can run locally at `http://localhost:11434` or act as a gateway to Ollama Cloud. Local execution keeps model inference on the user's machine; Ollama Cloud is a separate paid/service relationship governed by [Ollama's policies](https://ollama.com/terms). The plugin sends the configured endpoint the same agent request; it does not validate that a remote URL is private.

See [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy), [consumer terms](https://www.anthropic.com/legal/consumer-terms), and [commercial terms](https://www.anthropic.com/legal/commercial-terms) for provider-controlled processing. Those links are not an endorsement or affiliation claim.

## Network services and data flow

Claude Synapse itself has no analytics, crash-reporting, advertising, or telemetry service. It does not transmit vault contents to the maintainer. Network traffic is conditional:

| Destination | When contacted | Data that can leave the machine |
|---|---|---|
| Claude CLI / Anthropic | Claude subscription or API-key sessions, through the CLI and Agent SDK | Prompts, selected vault text, attachments, tool results, and conversation/session content needed by the provider; provider logs and telemetry are outside this plugin's control |
| User-configured Messages API endpoint | When a local agent endpoint is configured; model discovery also requests `/v1/models` and the Test button sends one minimal `/v1/messages` request | The configured URL receives the request body, model data, API key/header, and subsequent agent context |
| `https://api.telegram.org` | Only when the optional Telegram bot is connected | Bot token, polling metadata, Telegram messages and attachments; replies and generated text are sent back through Telegram |
| MCP servers | Only when the user enables/configures them | Whatever the configured MCP process or remote MCP transport sends; this plugin does not audit MCP privacy policies |

The Claude CLI and `@anthropic-ai/claude-agent-sdk` are separate components installed or bundled for local use. The SDK starts a Claude CLI subprocess for queries (and may start a fresh process for a send/resume operation); the plugin communicates with it locally using the SDK's protocol. The CLI then performs provider communication according to the selected authentication, endpoint, and its own policies. Claude Synapse does not embed a hosted Claude backend.

## Filesystem, tools, and subprocesses

- The normal working directory is the user's selected vault directory (or a user-selected directory in the chat control). The agent and its tools may autonomously read content from any accessible file in that working directory, not only text explicitly selected by the user; that content can become prompt context or tool input and may be sent to the selected model/provider.
- A scoped vault search or attachment can grant access to explicitly selected paths outside the current working directory. MCP configuration and additional SDK locations can grant still more filesystem access. Providers and tools may autonomously read content from any file accessible through those locations, not merely explicitly selected text. Attachments may be copied to the operating system temporary directory for the request. The plugin does not promise that a provider or an enabled tool will only ever see vault files.
- The optional Telegram runner uses the vault root and deliberately runs unattended with bypassed permission prompts. It is gated by the configured numeric Telegram allowlist; an allowed user can cause reads, writes, tool calls, and MCP actions without someone at the desktop. Telegram photos and files are downloaded into `_synapse/bot-attachments` inside the vault, so they may be synced with the vault and are not automatically deleted.
- `_synapse/.mcp.json`, agent definitions, and skills are vault-local configuration. Configured MCP stdio servers are started as local child processes by the Claude Agent SDK; HTTP/SSE MCP entries can contact their configured remote service. MCP tools can read/write outside the vault, execute arbitrary commands, or access network services. Treat synced/shared configuration as executable code.
- The Claude CLI binary is resolved from the explicit setting, supported global/OS installation locations, or its SDK package fallback. A configured CLI path is executed locally; it is not verified to be authentic by this plugin.

Tool approval defaults to **Ask**. **Allow**, plan/bypass modes, Telegram, a permissive agent definition, or an MCP server can remove the human approval boundary. Keep approval enabled and review vault-local configuration unless the unattended behavior is intentional.

## Privacy, advertising, and source

Claude Synapse is an independent, open-source project. It has no in-plugin advertising and no maintainer telemetry. Provider-side processing, provider telemetry, third-party MCP behavior, Telegram retention, and Ollama Cloud processing are governed by those services' policies, not by Claude Synapse.

Source code is available in this repository under the MIT License for new Claude Synapse code.

- [Security policy and reporting](SECURITY.md)
- [Architecture](specs/ARCHITECTURE.md)
- [Configuration](wiki/Configuration.md)
- [Customization and MCP](wiki/Customization.md)
- [Telegram bot](wiki/Telegram-Bot.md)
- [Ollama](wiki/Local-Models-Ollama.md)
