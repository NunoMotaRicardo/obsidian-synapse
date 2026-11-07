# Using vLLM and LiteLLM with Claude Synapse

Claude Synapse talks to a local model through the **Anthropic Messages API** (`/v1/messages`) and
lists models from `/v1/models`. [vLLM](https://docs.vllm.ai) serves an OpenAI-compatible API, so put
[LiteLLM](https://docs.litellm.ai) in front of it: LiteLLM exposes the Anthropic-style endpoints
and translates them to vLLM. Ollama needs no gateway — see
[Local models with Ollama](Local-Models-Ollama.md). Both use the same **Local agent endpoint**
setting, so you can switch between them by changing the URL.

```
Claude Synapse → Claude CLI → LiteLLM (:4000, /v1/messages) → vLLM (:8000, /v1/chat/completions)
```

## Tested setup

Verified with LiteLLM on `127.0.0.1:4000` and vLLM on `127.0.0.1:8000` serving
`RedHatAI/granite-3.1-8b-instruct-FP8-dynamic` (context 32768):

| Check | Result |
|-------|--------|
| `GET /v1/models` with the `x-api-key` header | Works; lists the LiteLLM `model_name` aliases |
| `POST /v1/messages` (plain) | Works; Anthropic-format reply |
| `POST /v1/messages` with `tools` | Works; returns a `tool_use` block |
| `POST /v1/messages` with `stream: true` | Works; Anthropic SSE events (`message_start`, `content_block_start`, …) |
| Request with a Claude model name (`claude-haiku-*`) | Rejected as an invalid model name — handled by the plugin, see below |
| Chat through the plugin with the 7-tool local toolset | Completes (see the model-quality caveat below) |

## 1. Run vLLM with tool calling enabled

Tool use needs vLLM's tool parser. Without it the model can chat but file and vault tools fail:

```bash
vllm serve RedHatAI/granite-3.1-8b-instruct-FP8-dynamic \
  --host 127.0.0.1 --port 8000 --max-model-len 32768 \
  --enable-auto-tool-choice --tool-call-parser granite
```

Pick the parser for your model family (`granite`, `hermes` for Qwen, `llama3_json`, …).

## 2. Configure LiteLLM

```yaml
model_list:
  - model_name: granite              # the name shown in Synapse's model picker
    litellm_params:
      model: openai/RedHatAI/granite-3.1-8b-instruct-FP8-dynamic
      api_base: http://127.0.0.1:8000/v1
      api_key: none

general_settings:
  master_key: sk-your-key            # optional; see "Endpoint API key" below

litellm_settings:
  drop_params: true
```

Run it with `litellm --config config.yaml --host 127.0.0.1 --port 4000`.

## 3. Configure Claude Synapse

Open **Settings → Claude Synapse → Claude → Local agent endpoint**:

- **Endpoint URL** — `http://localhost:4000`.
- **Endpoint API key** — your LiteLLM `master_key`. **This is required when LiteLLM has a master
  key.** Leaving it blank sends the literal `ollama` (right for Ollama, which ignores it), and
  LiteLLM answers `400/401 Authentication Error`. Synapse then shows a message pointing at this
  setting.
- Click **Test**; the `model_name` entries appear in the chat panel's model picker.

## What Synapse does differently for local models

- **Background model names.** The Claude CLI also sends small background requests with a
  Haiku-class model name. Synapse pins `ANTHROPIC_SMALL_FAST_MODEL` and
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` to the model you selected, so a gateway such as LiteLLM that
  rejects unknown model names doesn't fail those calls. Variables you set yourself win.
- **Lean built-in toolset.** Every tool schema is prompt text a small model reads on every turn.
  Local-model queries get only `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash` and `Skill`
  (plus `TodoWrite` for the plan panel) instead of the CLI's full set. Claude models are
  unaffected.
- **MCP servers are not loaded** — see below.

## MCP server trimming for local models

MCP servers from your user settings (`~/.claude`), a project `.mcp.json` and plugins each add
tool schemas to every request. In testing, a handful of servers added about **86,000 characters**
(~20k+ tokens) of tool definitions, which overflowed vLLM's 32k context
(`ContextWindowExceededError`) before the conversation even started. With MCP servers excluded,
the tool definitions were about **13,600 characters** (7 built-in tools).

So for local models Synapse launches the CLI with `strictMcpConfig`: only MCP servers passed
explicitly by the plugin load. This also drops MCP servers declared in a vault's `_synapse/`
folder and in plugins when a local model is selected.

To load them anyway (for example with a large-context model), turn on **Settings → Claude
Synapse → Claude → Local agent endpoint → Load MCP servers for local models**. It is off by
default. Claude-model queries always load MCP servers as usual.

## Context size and model quality

- Keep `--max-model-len` at **16384 or higher** — the CLI's system prompt and tool definitions
  consume several thousand tokens before your message (same guidance as the Ollama context-window
  section).
- Small models (such as an 8B Granite) can answer without calling tools, or call them
  unreliably — in testing one answered a "read this file" request from memory with a wrong
  value. Tool parsing itself works; for dependable agent behaviour use a stronger tool-calling
  model (Qwen 2.5/3 or Llama 3.1 class and larger).

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `Authentication Error` / "endpoint rejected the API key" | Set **Endpoint API key** to the LiteLLM `master_key` |
| `Invalid model name … claude-haiku` | Update to a Synapse build with the background model pin; make sure the model picker has a local model selected |
| `ContextWindowExceededError` | Raise `--max-model-len`, and keep **Load MCP servers for local models** off |
| Model replies in text but never uses tools | Start vLLM with `--enable-auto-tool-choice --tool-call-parser <parser>`; try a stronger model |
| `Cannot connect to host 127.0.0.1:8000` in an error | vLLM isn't running (LiteLLM is up but its upstream is down) |
| Test button OK but no models | The `model_list` in the LiteLLM config is empty |
