# Ollama Cloud Models Support

## Context

With the launch of Ollama Cloud, users can now run large, high-performance models (such as `deepseek-v3.1:671b-cloud`) hosted on Ollama's cloud infrastructure. The user requested investigation into adding support for these cloud models alongside the existing local models in the Sidekick plugin.

## Decision

We decided to **not make any codebase modifications or add a separate provider preset** (e.g. `ollama-cloud`) to support Ollama Cloud models. 

Instead, we will rely on and document the **Local Ollama Gateway** pattern. Users can run and access both local and cloud-hosted models seamlessly through the existing `Ollama` preset by logging into Ollama on their local machine and pulling the cloud-hosted models.

## Rationale

1. **Zero Code Changes & Maintainability**: The local Ollama daemon natively routes requests for cloud models (identified by the `:cloud` suffix) to the Ollama Cloud servers. Since the existing local `Ollama` preset already communicates with the local daemon via `http://localhost:11434` and fetches model tags dynamically, it already detects and runs cloud models without any software updates.
2. **Simplified Authentication & Security**: The local Ollama daemon manages authentication via the user's local CLI session (established via `ollama signin`). Adding direct cloud integration in the plugin would require adding new UI fields, managing another set of credentials (`OLLAMA_API_KEY`) securely, and bypassing local-only error handlers.
3. **Local Fallbacks**: Running cloud models via the local daemon allows users to switch between local and cloud models in the same environment and use local tool-calling capabilities.

## Scope / Non-goals

- **Not in scope**: Direct connection to `https://ollama.com/api` via the plugin settings.
- **Not in scope**: UI elements for inputting an `OLLAMA_API_KEY` specifically for Ollama Cloud.

## Open Questions

None. The gateway pattern is supported by the local Ollama CLI and has been verified.

## Hand-off Notes for the Technical Planner

None. No code changes are required. The task is completed by documenting the setup.

## Related

- [`../ollama-cloud-setup.md`](../ollama-cloud-setup.md) — Ollama Cloud setup guide
- [`2026-06-25-ollama-support-and-multimodal.md`](2026-06-25-ollama-support-and-multimodal.md) — Ollama reliability and multimodal phase plan

