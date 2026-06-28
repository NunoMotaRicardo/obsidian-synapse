# Configuring Ollama context window for Sidekick

## The problem

The GitHub Copilot CLI sends a system prompt and ~59 built-in tool definitions with every request, consuming approximately **4,000 tokens** before your message is even included. Ollama defaults to a 4,096-token context window (`num_ctx`), which leaves almost no room for actual conversation.

When the context is exhausted, Ollama returns an empty response (`finish_reason: length`), and the CLI retries by replaying that empty turn as `content: null`. Ollama rejects null content, producing the misleading error:

```
Error: 400 invalid message content type: <nil>
```

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

**Do not go below 8192.** The Copilot CLI's system prompt + tool definitions need ~4,000 tokens as a baseline before any user content.

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

Sidekick also supports a **Context window (tokens)** setting in **Settings → Models** (for BYOK providers). This controls when the Copilot SDK compacts conversation history *before* sending to the provider. Set it to a value slightly below your Ollama context (e.g. 14000 for a 16384 context) so long conversations compact gracefully instead of hitting the hard limit.

## Troubleshooting

**Still getting `invalid message content type: <nil>`?**
- Verify the override took effect: `ps aux | grep '[l]lama-server' | grep -oE '\-c [0-9]+'` should show the new value.
- Make sure you restarted the correct Ollama instance (the one in WSL, not the Windows tray app).
- Start a **new chat** in Sidekick (click `+`) — existing sessions cache the old config.

**Getting `exceed_context_size_error`?**
- The request (system prompt + tools + conversation history) exceeds your `num_ctx`. Either increase the context size or enable SDK-side compaction via the **Context window (tokens)** setting.

**How to check VRAM usage:**

```bash
nvidia-smi
# or for continuous monitoring:
watch -n 1 nvidia-smi
```
