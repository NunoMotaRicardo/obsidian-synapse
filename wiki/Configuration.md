# Configuration

Open **Settings → Claude Synapse**. The settings screen has five tabs.

## Claude

Choose how Claude Synapse authenticates with Claude:

- **Claude subscription (OAuth)** — use the Claude CLI login; run `claude login` in a terminal if needed.
- **Anthropic API key** — enter an API key, which Claude Synapse stores in vault-specific local storage rather than the plugin data file.
- **Claude CLI location** — optionally set a path to the CLI; leave it blank for automatic discovery. The page shows the resolved CLI and version.

### Local agent endpoint

Set an **Endpoint URL** and optional **Endpoint API key** to use Ollama v0.14.0+ or another endpoint that speaks the Anthropic Messages API. The **Test** button verifies the endpoint, and its model catalogue is added to the chat model picker. A configured endpoint receives the entire agent loop, including tool calls, so use only an endpoint you trust with your vault context.

OpenAI-compatible-only endpoints are not supported directly. See [Local models with Ollama](Local-Models-Ollama.md) for setup and context-window guidance.

## Feature Map & Agents

Choose the default agent for the chat panel, inline editor operations, semantic search, Telegram, and image reading. The list shows the agents in `_synapse/agents/`, such as the starter kit's **Writer**. **Auto** (the default) uses Claude's default agent. Agent model bindings can also be edited here. See [Customization](Customization.md) for the file formats.

## Capabilities

**Initialize** installs the [starter kit](Starter-Kit.md) into `_synapse/`: the Writer agent and the `synapse-config`, `obsidian`, `think`, and `writing-style` skills. It only adds missing files and never overwrites your changes. This tab also controls:

- automatic working-directory updates as you switch notes;
- automatically attaching images embedded in the active note and the image limit;
- request timeout; and
- optional chat-run turn, token, and dollar guardrails. Turn and token limits can cancel a run; the dollar budget is reported after a run completes.

## Tools

**Tools approval** defaults to **Ask**, which asks before a tool runs. **Allow** automatically approves tool calls for chat, editor actions, and search. Telegram sessions always run unattended, so restrict bot access carefully.

## Bots

Configure and connect a Telegram bot with its identifier, token, allowed user IDs, and default agent. The token is stored securely. Only add trusted users: an allowed Telegram user can invoke unattended agent tool calls against the vault. Setup steps: [Telegram bot](Telegram-Bot.md).

## Suggested reading

- [Starter kit](Starter-Kit.md) — the bundled agent and skills
- [Customization](Customization.md) — agents, skills, MCP servers, and vault settings
- [Local models with Ollama](Local-Models-Ollama.md) — compatible endpoint setup
- [Claude Code settings](https://code.claude.com/docs/en/settings) — settings supported by the Claude CLI
