# Using Ollama Cloud Models with Sidekick

Ollama offers **Cloud models**, which allow you to run large, high-performance models (such as `deepseek-v3.1:671b-cloud` or `gpt-oss:120b-cloud`) hosted on Ollama's datacenter-grade hardware. 

Instead of adding a new preset or direct cloud API integration to the plugin, Sidekick leverages your local Ollama daemon as a gateway. This means you can use both local and cloud-hosted models seamlessly without changing your plugin configuration or managing raw API keys in your settings.

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

### 4. Configure Sidekick
1. Open Obsidian and go to **Settings** → **Sidekick**.
2. Go to the **Models** tab.
3. Select **Ollama** as your **Provider**.
4. Keep the default **Base URL** (`http://localhost:11434/v1`).
5. Click **Test** to fetch your model list. Sidekick will automatically detect the cloud model from your local daemon.
6. In the **Model name** input field, select or type the cloud model name exactly as it appeared in `ollama list` (e.g., `deepseek-v3.1:671b-cloud`).
7. Save settings.

---

## Benefits of the Gateway Approach

* **Zero Memory Overhead**: Although the cloud model is registered with your local Ollama daemon, the heavy GPU computations run in the cloud. Your local machine does not need a high-end GPU or large amounts of VRAM to use these large models.
* **Unified Provider Preset**: You can switch between local models (like `llama3.2`) and cloud models (like `deepseek-v3.1:671b-cloud`) instantly under a single provider preset.
* **Secure Credential Management**: The plugin does not need to store your Ollama API key. Authentication is handled entirely by your local Ollama installation.
