# Configuration

**Settings → Synapse**

### Models

| Setting | Default | Description |
|---------|---------|-------------|
| **Provider** | Anthropic | Anthropic, Ollama, MS Foundry Local, or Other |
| **Model name** | *(empty)* | Model ID (e.g. `claude-3-5-sonnet-latest`, `llama3`) |
| **API key / Token** | *(empty)* | Credentials for the chosen provider |

### Supported providers

| Provider | Preset | Default endpoint |
|----------|--------|-----------------|
| **Anthropic** | `anthropic` | `https://api.anthropic.com` |
| **Ollama** | `ollama` | `http://localhost:11434/v1` |
| **Microsoft Foundry Local** | `openai` | Local Foundry model server |
| **Other OpenAI-compatible** | `openai` | Any compatible endpoint |

See [Local-Models-Ollama](Local-Models-Ollama.md) and [Local-Models-Foundry](Local-Models-Foundry.md) for provider-specific setup.

### Synapse settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Inline operations model** | Default | Model for context-menu actions |
| **Tools approval** | Ask | `Allow` (auto) or `Ask` (confirm each call) |
| **Reasoning effort** | *(unset)* | Low / Medium / High / XHigh — when supported by the model |
| **Search mode** | Basic | `Basic` (quick) or `Advanced` (full agent/model/skills/tools config) |
