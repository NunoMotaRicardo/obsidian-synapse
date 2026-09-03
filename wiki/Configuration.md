# Configuration

**Settings → Synapse**

### Models

| Setting | Default | Description |
|---------|---------|-------------|
| **Provider** | Ollama | `Ollama`, `OpenAI-compatible`, or `Azure OpenAI` |
| **Base URL** | `http://localhost:11434` | Endpoint for the selected preset |
| **Model name** | *(empty)* | Model ID (e.g. `claude-3-5-sonnet-latest`, `llama3`) |
| **API key** | *(empty)* | Credentials for the chosen provider (hidden for Ollama) |

### Supported providers

The dropdown has three presets, but the **OpenAI-compatible** preset works unchanged with any
endpoint exposing `/v1/chat/completions` — which covers most real-world providers:

| Provider | Preset | Base URL | Notes |
|---|---|---|---|
| Ollama (local) | Ollama | `http://localhost:11434` | Default. Capabilities auto-detected |
| Ollama Cloud | Ollama | `http://localhost:11434` | `ollama signin`, pull a `:cloud` model |
| OpenRouter | OpenAI-compatible | `https://openrouter.ai/api/v1` | 400+ models, one key |
| OpenAI | OpenAI-compatible | `https://api.openai.com` | |
| LM Studio | OpenAI-compatible | `http://localhost:1234/v1` | |
| llama.cpp server | OpenAI-compatible | `http://localhost:8080/v1` | |
| vLLM | OpenAI-compatible | `http://localhost:8000/v1` | |
| Groq / Together / DeepSeek / Mistral | OpenAI-compatible | provider's `/v1` | |
| Foundry Local | OpenAI-compatible | `http://localhost:<port>/v1` | Port from `foundry service status`. **Model list unavailable** — enter the id manually |
| Azure OpenAI | Azure OpenAI | `https://<res>.openai.azure.com/openai` | v1 API only; classic deployment URLs unsupported |
| Anthropic | — | — | Use **Settings → Claude → API key**, not this section |

**OpenRouter** is worth calling out specifically: it aggregates 400+ models from 60+ providers
behind a single OpenAI-compatible API, so it needs no code changes — select **OpenAI-compatible**,
set **Base URL** to `https://openrouter.ai/api/v1`, and paste your OpenRouter API key into
**API key**. It is the natural choice for "a model that isn't Claude and isn't running on my
laptop," with one key covering most of the model landscape.

See [Local-Models-Ollama](Local-Models-Ollama.md) and [Local-Models-Foundry](Local-Models-Foundry.md) for provider-specific setup.

### Synapse settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Inline operations model** | Default | Model for context-menu actions |
| **Tools approval** | Ask | `Allow` (auto) or `Ask` (confirm each call) |
| **Reasoning effort** | *(unset)* | Low / Medium / High / XHigh — when supported by the model |
| **Search mode** | Basic | `Basic` (quick) or `Advanced` (full agent/model/skills/tools config) |
