# Local Model ReAct Loop + MCP Bridge Guide

This guide explains how to configure and use local models (such as `qwen3`, `gemma4`, and `nemotron`) in a tool-calling ReAct loop with built-in vault tools and external MCP servers.

---

## 1. Overview of the ReAct Loop

When you select a local model provider preset (**Ollama** or **OpenAI-compatible** — the latter covers LM Studio, llama.cpp, vLLM, Foundry Local, and any other OpenAI-compatible endpoint) and the model supports tool usage, Synapse wraps the session queries in an autonomous **Reasoning & Action (ReAct) loop**.

- **Stateless Execution**: Unlike Claude agentic sessions, the local ReAct loop runs statelessly per-query or per-batch-loop-item execution.
- **Loop Limits**: The loop executes up to **5 turns** (`maxTurns = 5`) to prevent runaway API requests.
- **No streaming, any preset**: `executeLocalProviderQuery()` never streams the response — Ollama's request body sets `stream: false` explicitly, and every OpenAI-compatible preset (including Azure) omits the `stream` field entirely, which those APIs default to non-streaming. Obsidian's `requestUrl()` (used for every local-provider call) also has no server-sent-events support, so the full response always arrives as one parsed JSON payload regardless of provider.

The loop sequence is managed by [executeLocalProviderQuery()](https://github.com/NunoMotaRicardo/obsidian-synapse/blob/main/src/providerModels.ts#L238-L248) inside [providerModels.ts](https://github.com/NunoMotaRicardo/obsidian-synapse/blob/main/src/providerModels.ts):
1. **Thought & Call**: The model returns text reasoning (if supported) followed by tool-call intents.
2. **Execution**: Synapse executes the requested tools (either built-in vault tools or MCP tools) locally.
3. **Observation**: Results are returned to the model in the conversation history as observations.
4. **Conclusion**: The loop repeats until the model chooses to respond with a final text answer without further tool calls.

---

## 2. Local Model Capabilities & Requirements

Not all local models can participate in a ReAct loop. Tool-calling requires native model capability and JSON-structure compliance.

- **Recommended Modern Models**:
  - **`qwen3`** (or `qwen3:8b` / `qwen3:72b`): Excellent function calling and structured reasoning.
  - **`gemma4`**: Highly optimized for instruction-following and tool selection.
  - **`nemotron`**: Strong performance in complex agentic planning and tool parameter assembly.
- **Function-Calling Support**: Ensure the pulled local model supports tool usage. Check the model capabilities using:
  ```bash
  ollama show <model-name>
  ```
  Look for `template` variables handling tools or `tools` support in its definition.
- **Cheap One-Shot Fallback**: If a selected local model does *not* support function-calling, the ReAct loop is bypassed, and it runs as a standard one-shot prompt/completion call.

---

## 3. Built-In Vault Tools

When a local model runs in a ReAct loop, Synapse automatically equips it with the following built-in Obsidian vault tools, defined in [vaultTools.ts](https://github.com/NunoMotaRicardo/obsidian-synapse/blob/main/src/vaultTools.ts):

### `read_note`
Reads the full plain-text content of any note/file inside your vault.
- **Parameters**:
  - `path` (string, **required**): The vault-relative path of the file to read (e.g., `"folder/note.md"`).

### `list_notes`
Lists file paths within the vault, optionally matching a search glob.
- **Parameters**:
  - `glob` (string, **optional**): A glob pattern to filter files (e.g., `"folder/*.md"` or `"**.md"`).

### `search_notes`
Performs a case-insensitive search across the bodies of all markdown files in the vault.
- **Parameters**:
  - `query` (string, **required**): The query text to search for.
- **Output**: Returns the file path and matching snippet lines (up to 3 matching lines per file).

---

## 4. MCP Server Configuration (`_synapse/.mcp.json`)

You can extend the local model's tool capabilities by configuring external Model Context Protocol (MCP) servers. The MCP bridge spawns these servers as subprocesses, negotiates tools via JSON-RPC 2.0 over stdin/stdout, and exposes their tools to the ReAct loop.

### Configuration Format

Create or edit the file `_synapse/.mcp.json` at the root of your Obsidian vault:

```json
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "sk_..."
      }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

- **`mcpServers`**: Key-value map of server identifier names to their runtime parameters.
- **`command` & `args`**: Command-line arguments to launch the server.
- **`env`**: Optional environment variables used to pass API keys and secret tokens to the server.

### Windows OS Command Resolution
On Windows, command aliases like `npx`, `npm`, `pnpm`, and `yarn` are automatically resolved to their executable `.cmd` versions by the bridge to prevent spawn failures.

---

## 5. Error Handling & Loop Safety

The local ReAct loop is designed to fail gracefully without hanging Obsidian:

- **JSON-RPC Errors**: If an MCP server returns a JSON-RPC error, the bridge catches it and returns the error message as the tool observation rather than crashing the loop.
- **Spawn Failures**: If a configured MCP server fails to launch, Synapse logs the error, excludes its tools, and continues execution with the remaining tools.
- **15-Second Timeouts**: The bridge limits JSON-RPC tool request wait times to **15 seconds** to prevent frozen subprocesses from locking up your session.
- **Lifecycle Management**: Spawned MCP server processes are shut down in a `finally` block immediately after the local provider query completes.

---

## 6. Suggested Reading

- [AI Customization Guide](Customization.md) — How customization plugins, agents, and skills are laid out.
- [MCP Bridge Specification](https://github.com/NunoMotaRicardo/obsidian-synapse/blob/main/specs/mcp-bridge.md) — Detailed technical specs of the JSON-RPC handshake and process lifecycle.
