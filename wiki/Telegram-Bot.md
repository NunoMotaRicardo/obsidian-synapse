# Telegram bot

Connect a Telegram bot and chat with your Synapse agents from anywhere. Messages you send the bot
are handled by Synapse on your computer, with your agents, models, skills, and MCP tools, and the
reply comes back to the chat. Obsidian must be running for the bot to answer.

## 1. Create a bot

1. In Telegram, message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the **bot token**.

## 2. Connect it in Synapse

Open **Settings → Synapse → Bots**:

| Setting | Description |
|---|---|
| **Bot identifier** | Your bot's username, for your reference |
| **Bot token** | The token from BotFather, stored securely outside the plugin's data file |
| **Allowed users** | Comma-separated Telegram user IDs that may use the bot (required) |
| **Default agent** | The agent that answers incoming messages |

Click **Connect**. The bot silently ignores anyone who isn't in **Allowed users**. Send `/new` in
Telegram to start a fresh session.

> [!WARNING]
> Telegram sessions run **unattended**: nobody is at the keyboard to approve a tool call. Only add
> user IDs you trust completely, and consider a bot agent whose `tools` list is restricted. See
> [Customization](Customization.md#2-agents-_synapseagentsmd).

## Suggested reading

- [Configuration](Configuration.md): all settings tabs
- [Starter kit](Starter-Kit.md): the **Writer** agent works well as a bot agent for drafting on the go
