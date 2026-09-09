# Configuration

**Settings → Synapse**

### Models

| Setting | Default | Description |
|---------|---------|-------------|
| **Endpoint URL** | *(empty)* | Base URL of a Messages-API-speaking endpoint, e.g. `http://localhost:11434` for Ollama v0.14.0+. Blank = only Claude models are available |
| **Endpoint API key** | *(empty)* | API key sent to the endpoint. Ollama ignores the value but requires the header — leave blank to send `ollama` automatically |
| **Model name** | *(empty)* | Model ID used for inline editor operations (e.g. `claude-sonnet-5`, `llama3`) — leave blank for the CLI default |

### Local agent endpoint

Local models — Ollama, or any other endpoint that speaks the **Anthropic Messages API** — run
through the same Claude Agent SDK/CLI as Claude models: full skills, subagents, sessions,
permission modes, and streaming. There is no provider preset dropdown and no
OpenAI-compatible-only integration; an endpoint that speaks only the OpenAI-shaped
`/v1/chat/completions` surface (LM Studio, llama.cpp, vLLM, a bare OpenAI-compatible server) is
not supported directly — put a Messages-API-speaking gateway in front of it, or use Ollama, which
speaks the Messages API natively.

See [Local-Models-Ollama](Local-Models-Ollama.md) for Ollama-specific setup, including Ollama
Cloud models and context-window tuning.

### Synapse settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Inline operations model** | Default | Model for context-menu actions |
| **Tools approval** | Ask | `Allow` (auto) or `Ask` (confirm each call) |
| **Reasoning effort** | *(unset)* | Low / Medium / High / XHigh — when supported by the model |
| **Search mode** | Basic | `Basic` (quick) or `Advanced` (full agent/model/skills/tools config) |
