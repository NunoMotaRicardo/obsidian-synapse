# Using Ollama with Claude Synapse

Ollama v0.14.0+ speaks the same **Anthropic Messages API** the Claude CLI itself uses. Claude Synapse
points the CLI directly at your local Ollama daemon for local-model queries — the same real
Claude Agent SDK a Claude session uses, with full skills, subagents, sessions, permission modes,
and streaming (there is no separate, degraded local-model loop). See [Customization](Customization.md)
for how agents/skills/`.mcp.json` apply the same way regardless of which model is selected.

## Configuring the local agent endpoint

1. Install and run Ollama locally (`ollama serve`), or point at a remote/proxied instance you trust.
2. Open Obsidian **Settings → Claude Synapse → Claude → Local agent endpoint** and set:
   - **Endpoint URL** — `http://localhost:11434` (the default).
   - **Endpoint API key** — leave blank; Ollama ignores the value but requires the header, so
     Claude Synapse sends the literal `ollama` automatically.
3. Click **Test** to verify the endpoint answers the Messages API. Once configured, Ollama's
   installed models appear automatically in the chat panel's model picker.
4. Pull models with `ollama pull <model>` as usual — no restart needed, the model list refreshes
   next time the endpoint is queried.

---

## Ollama Cloud Models with Claude Synapse

Ollama offers **Cloud models**, which allow you to run large, high-performance models (such as `deepseek-v3.1:671b-cloud` or `gpt-oss:120b-cloud`) hosted on Ollama's datacenter-grade hardware. 

Instead of adding a new preset or direct cloud API integration to the plugin, Claude Synapse leverages your local Ollama daemon as a gateway. This means you can use both local and cloud-hosted models seamlessly without changing your plugin configuration or managing raw API keys in your settings.

---

## Prerequisites

1. **Ollama Installed**: Ensure you have Ollama installed locally on your system.
2. **Ollama Account**: Create an account at [ollama.com](https://ollama.com).

---

## Setup Steps

### 1. Sign In via the Ollama CLI
To authenticate your local Ollama daemon with Ollama Cloud, run the sign-in command in your terminal:

```bash
ollama signin
```

This will prompt you to complete authentication in your browser. Once complete, your local daemon is authorized to pull and run cloud models.

### 2. Pull the Cloud Model Locally
You must register/pull the cloud model to your local Ollama instance so it becomes visible to applications. Run:

```bash
ollama pull <model-name>:cloud
# Example:
ollama pull deepseek-v3.1:671b-cloud
```

*(Note the mandatory `:cloud` suffix on the model name.)*

### 3. Verify in Local CLI
Confirm that the cloud model is registered and available locally by running:

```bash
ollama list
```

You should see your cloud model (e.g., `deepseek-v3.1:671b-cloud`) in the list.

### 4. Configure Claude Synapse
1. Open Obsidian and go to **Settings** → **Claude Synapse** → **Claude** → **Local agent endpoint**.
2. Keep the default **Endpoint URL** (`http://localhost:11434`) and leave **Endpoint API key** blank.
3. Click **Test** to verify the endpoint, then select the cloud model (e.g. `deepseek-v3.1:671b-cloud`) from the chat panel's model picker — it's fetched automatically from your local daemon's catalogue, the same as any other installed model.

---

## Benefits of the Gateway Approach

* **Zero Memory Overhead**: Although the cloud model is registered with your local Ollama daemon, the heavy GPU computations run in the cloud. Your local machine does not need a high-end GPU or large amounts of VRAM to use these large models.
* **One endpoint, both kinds of model**: You can switch between local models (like `llama3.2`) and cloud models (like `deepseek-v3.1:671b-cloud`) instantly — both are served through the same local agent endpoint.
* **Secure Credential Management**: The plugin does not need to store your Ollama API key. Authentication is handled entirely by your local Ollama installation.

---

# Configuring Ollama context window for Claude Synapse

## The problem

The Claude CLI (spawned by `@anthropic-ai/claude-agent-sdk` under Claude Synapse) sends a system prompt and built-in tool definitions with every request, consuming approximately **4,000 tokens** before your message is even included. Ollama defaults to a 4,096-token context window (`num_ctx`), which leaves almost no room for actual conversation.

When the context is exhausted, Ollama returns an empty response or an error, causing the request to fail.

The fix is to increase Ollama's context window so the CLI's baseline overhead fits comfortably alongside your conversation.

## Prerequisites

- Ollama running as a **systemd service** inside a WSL distro (the standard setup when installed via the Linux install script inside WSL)
- To find which distro runs Ollama: `wsl -l -v` to list running distros, then check each with:
  ```powershell
  wsl -d "<distro-name>" -e bash -c "systemctl is-active ollama"
  ```

## Configuration steps

### 1. Open a shell in the WSL distro running Ollama

From Windows Terminal or PowerShell:

```powershell
wsl -d "<distro-name>"
```

### 2. Create a systemd override

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_CONTEXT_LENGTH=16384"
EOF
```

This sets the default context window for all models served by this Ollama instance.

### 3. Apply the change

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

### 4. Verify

After sending a chat message (so a model loads), confirm the context flag on the running model server:

```bash
ps aux | grep '[l]lama-server' | grep -oE '\-c [0-9]+'
```

Expected output: `-c 16384`

You can also check the service environment directly:

```bash
systemctl show ollama -p Environment
```

## Choosing a context size

The right value depends on your model size and available VRAM. The table below uses **gemma4:12b** (~8 GB model weight) on **16 GB VRAM** as the reference.

| `num_ctx` | Approx. KV cache | Recommendation |
|-----------|-------------------|----------------|
| 4096 | ~0.5 GB | Too small — the CLI's tools alone consume ~4 K tokens |
| 8192 | ~1-2 GB | Minimum viable — short conversations only |
| **16384** | ~2-4 GB | Good default for general use |
| 32768 | ~5-7 GB | Long sessions; monitor VRAM with `nvidia-smi` |

**Do not go below 8192.** The CLI's system prompt + tool definitions need ~4,000 tokens as a baseline before any user content.

For larger models (e.g. 27B+), reduce the context size accordingly since the model weights consume more VRAM.

## Changing or removing the override

**To change the value:** edit the override file, then reload and restart:

```bash
sudo nano /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

**To remove entirely** (revert to Ollama's 4096 default):

```bash
sudo rm /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

## Complementary: SDK-side compaction

Claude Synapse natively leverages the Claude Agent SDK's auto-compaction feature (Infinite Sessions), which automatically compacts the conversation history when context utilization reaches ~80%. You can also configure the context-window tier or enable/disable this feature under the model settings menu in the chat view.

## Troubleshooting

- Verify the override took effect: `ps aux | grep '[l]lama-server' | grep -oE '\-c [0-9]+'` should show the new value.
- Make sure you restarted the correct Ollama instance (the one in WSL, not the Windows tray app).
- Start a **new chat** in Claude Synapse (click `+`) — existing sessions cache the old config.
