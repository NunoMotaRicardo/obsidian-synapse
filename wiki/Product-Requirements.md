# Product requirements: Claude Synapse

| | |
|---|---|
| **Product** | Claude Synapse (`claude-synapse`), an Obsidian desktop plugin |
| **Version described** | 0.4.1 (released 2026-10-08) |
| **Status** | Beta, distributed through BRAT and GitHub releases |
| **Owner** | Nuno Mota Ricardo |
| **Last updated** | 2026-10-09 |

This document describes Claude Synapse **as it is built today**. Every requirement below is
shipped unless it's listed under [Out of scope](#9-out-of-scope-and-retired-features) or
[Known limitations](#8-known-limitations). For module-level behavior, see
[`specs/`](../specs/ARCHITECTURE.md). For how to use each feature, see the rest of this wiki.

Claude Synapse is an independent plugin. It isn't affiliated with, endorsed by, or produced by
Anthropic.

---

## 1. Summary

Claude Synapse brings the Claude agent into Obsidian and makes the vault its workspace. Every
message runs on the Claude Agent SDK, the same agent loop as Claude Code, so the assistant can read
and write notes, follow links, run tools and MCP servers, delegate to subagents, use skills, and
keep a resumable history of every conversation.

It works in four places: a chat and search side panel, **Edit with Synapse** and other right-click
actions in the editor and file explorer, the command palette, and an optional Telegram bot. Agents, skills, MCP servers, and
permissions are plain files in the vault's `_synapse/` folder, and the user can create them by
asking in chat.

The same agent runs on Claude (subscription or API key) and on local or self-hosted models through
any endpoint that speaks the Anthropic Messages API, such as Ollama.

## 2. Problem

Knowledge workers keep what they know in Obsidian, but most AI tools sit outside it:

- **Copy-paste friction.** Users move notes into a chat window and paste answers back. The AI
  never sees links, folder structure, or the rest of the vault.
- **Chat wrappers aren't agents.** Existing Obsidian AI plugins mostly send a prompt and render a
  reply. They can't plan, use tools, edit several files, or run long multi-step work.
- **Generic voice.** AI drafts sound like AI, not like the person who wrote the vault.
- **Customization needs config screens.** Changing an assistant's behavior means forms, JSON, or
  code, so most users never do it.
- **Privacy versus capability.** Users want the best model for hard problems and a local model for
  private notes, usually with two different tools.

## 3. Users

| Persona | Needs | Typical use |
|---|---|---|
| **Writer** (essays, posts, speeches, reports) | Drafts in their own voice, grounded in their notes | Writer agent, writing styles, **Edit with Synapse** |
| **Researcher and knowledge gardener** | Find, summarize, and restructure large note collections | Vault search, folder summaries, chat scoped to a folder |
| **Power user and developer** | Extend the assistant with tools and workflows | Custom agents and skills, MCP servers, `_synapse/` under git |
| **Privacy-conscious user** | Keep sensitive notes on their machine | Ollama local models, per-agent model binding |
| **Mobile-on-the-go user** | Reach their vault agent away from the desk | Telegram bot |

All personas run Obsidian Desktop and are comfortable installing a CLI tool.

## 4. Goals and non-goals

### Goals

1. **G1. A real agent in the vault.** Full Claude Agent SDK capability (sessions, subagents,
   skills, MCP, permissions, streaming reasoning) inside Obsidian, with no reduced "lite" mode.
2. **G2. Context without effort.** The active note, selection, folder, and attachments reach the
   agent automatically.
3. **G3. Customization by conversation.** Users create and change agents, skills, MCP servers, and
   permissions by describing them, with approval before anything is written.
4. **G4. Everything is a note.** All customization is readable, editable, syncable, versionable
   Markdown or JSON in the vault.
5. **G5. One agent, any model.** Claude and local or self-hosted models share the same agent loop
   and features, selectable per conversation or per agent.
6. **G6. Safe by default.** Tool calls require approval by default, secrets stay out of synced
   files, and every network destination is disclosed.
7. **G7. Useful from the first message.** A starter kit delivers value before any setup.

### Non-goals

- Mobile Obsidian support. The plugin spawns a local CLI process, which needs Node.
- Hosting a model backend, selling accounts, or processing payments.
- Talking to model APIs directly. All model access goes through the Claude CLI.
- OpenAI-compatible-only endpoints. They need a gateway that speaks the Anthropic Messages API.
- Auto-updating the Claude CLI.
- Background automation without a person or a Telegram message (see [Out of scope](#9-out-of-scope-and-retired-features)).
- Maintainer telemetry, analytics, crash reporting, or advertising.

## 5. Product principles

- **Claude-native.** Use the SDK's own concepts (agents, skills, plugins, permission modes,
  settings layers) rather than inventing parallel ones. The `_synapse/` folder is registered as an
  SDK local plugin and discovered natively.
- **The user stays in control.** Proposals before writes, approval before tool calls, a second
  confirmation before deletions, and guardrails that can stop a runaway run.
- **Never overwrite the user's work.** Initialization only adds missing files. Resetting a bundled
  file asks for confirmation item by item.
- **Honest output.** The writing skills never invent statistics, quotes, or personal stories.
- **Obsidian-native UX.** Sentence-case copy, the settings search, command palette entries, and
  context menus behave like the rest of Obsidian.

## 6. Functional requirements

Requirement IDs are stable references for issues and reviews.

### 6.1 Runtime, authentication, and models

| ID | Requirement |
|---|---|
| RT-1 | The plugin drives the system-installed `claude` CLI through `@anthropic-ai/claude-agent-sdk`, spawning a CLI process per query. |
| RT-2 | The CLI is found automatically: settings override, then global npm install, then OS install locations (WinGet, `~/.claude/bin`, `/usr/local/bin`, and others), then the SDK package fallback. |
| RT-3 | When no CLI is found, a platform-specific notice explains how to install it. |
| RT-4 | **Settings → Claude** shows the resolved CLI path, its source, the CLI version, and the bundled SDK version, plus a non-blocking warning when CLI and SDK builds drift apart. |
| RT-5 | Authentication is either **Claude subscription (OAuth)**, using the CLI login, or **Anthropic API key**. |
| RT-6 | A **Local agent endpoint** (URL plus optional API key) points model queries at any Anthropic Messages API endpoint, such as Ollama v0.14.0 or newer, locally or as a gateway to Ollama Cloud. |
| RT-7 | The endpoint's model catalogue (`/v1/models`) is added to the model picker next to Claude models. The **Test** button reports how many models are available, or a clear failure reason, without sending any messages. |
| RT-8 | Local models get the same features as Claude: streaming, tools, skills, subagents, sessions, and permission modes. |
| RT-9 | Each agent can bind a model in its frontmatter, editable from **Settings → Feature Map & Agents**. A binding that doesn't match an available model falls back to the default. |
| RT-10 | Reasoning effort is selectable when the model supports it. An empty value means the model default. |
| RT-11 | `/model` in chat shows the current model and what each alias resolves to. `/model <name>` switches the model picker. |
| RT-12 | When a local endpoint is configured, Claude sessions get a delegation tool server (`cheap_generate`, `bulk_summarize`) that hands sub-tasks to the endpoint's default model. |

### 6.2 Chat panel

| ID | Requirement |
|---|---|
| CH-1 | The panel opens from the ribbon icon or **Open chat**, in the right sidebar, with **Chat** and **Search** tabs and a session list. |
| CH-2 | Responses stream with full Markdown rendering. **Enter** sends, **Shift+Enter** adds a line. |
| CH-3 | The active note or selection is included with each message, and a context line above the input shows the note, agent, and model. |
| CH-4 | The working directory follows the active note's folder. This can be turned off in **Capabilities**. |
| CH-5 | **Scope** limits which files and folders the assistant can see. |
| CH-6 | **Attach** adds files from disk. Files can also be dropped on the input or images pasted. Images embedded in the active note can be attached automatically, up to a configurable limit. |
| CH-7 | Typing `/` opens a picker for skills and supported commands. Slash commands are sent exactly as typed, with no added note context. |
| CH-8 | The toolbar provides **Agent**, **Model**, **Reasoning**, **Tools** (MCP tool list and approval mode), a **context gauge**, and **Debug** (tool calls, token usage, and timing inline). |
| CH-9 | Status shows the run stage: **Waiting for response…**, **Thinking…** (reasoning streams live in a collapsible block), or **Processing…** (a tool is running). |
| CH-10 | When the agent tracks a plan (`TodoWrite`, `TaskCreate`, `TaskUpdate`), a task panel shows its progress. |
| CH-11 | The agent can ask the user structured questions (elicitation forms and `AskUserQuestion`) through modals. |
| CH-12 | Write and edit tool failures are shown as friendly, actionable messages. When the API's safety filter blocks a request, the notice explains why, names the model, and lists what to try. |
| CH-13 | Context compaction events are shown in the conversation. |

### 6.3 Sessions

| ID | Requirement |
|---|---|
| SE-1 | Every conversation is saved and can be reopened with its history, including after restarting Obsidian. |
| SE-2 | The session list supports **New session**, filter by type, sort, search by name, rename, and delete. |
| SE-3 | A session keeps running in the background when the user switches to another. A green dot marks sessions still streaming. |
| SE-4 | Search runs appear as their own session type. |

### 6.4 Tool approval and permissions

| ID | Requirement |
|---|---|
| PE-1 | **Tools approval** defaults to **Ask**. **Allow** approves tool calls automatically for chat, editor actions, and search. |
| PE-2 | In **Ask** mode, a dialog shows exactly what will run, with **Allow** (this conversation), **Always allow** (saved to `_synapse/settings.json`, with a notice confirming where), and **Deny**. |
| PE-3 | `_synapse/settings.json` is a vault-level permission layer applied to every session. A new vault gets one that allows `Read`. An existing file is never overwritten. |
| PE-4 | Read-only tools are approved automatically. |

### 6.5 Run guardrails

| ID | Requirement |
|---|---|
| GR-1 | Optional **Turn limit** and **Token budget** stop an interactive chat run when exceeded and explain why in the chat. |
| GR-2 | An optional **Dollar budget (USD)** is reported after a run completes. |
| GR-3 | All guardrails default to off. A request timeout is configurable. |
| GR-4 | The user can stop any run in flight. |

### 6.6 Vault search

| ID | Requirement |
|---|---|
| SR-1 | Users describe what they're looking for in plain language, and an agent searches note contents and file names. |
| SR-2 | **Basic** mode is quick. **Advanced** mode lets the user choose agent, model, and tool approval. Tooltips explain each mode. |
| SR-3 | Results are clickable and open the note. |
| SR-4 | The starter kit's **Search** agent is the default search agent. If another agent runs a search, the search instructions are added to its prompt so results still render. |
| SR-5 | Search can be scoped to a folder from the file explorer. |

### 6.7 Editor and file actions

| ID | Requirement |
|---|---|
| ED-1 | Right-clicking in the editor shows one item: **Edit with Synapse** when text is selected, **Insert with Synapse** when it isn't. Both open a dialog for free-form instructions (Enter submits, Shift+Enter adds a line). |
| ED-2 | The model sees the whole note for context. Edits return only the replacement for the selection, and inserts return only the text for the cursor position. The result is applied directly, and Ctrl+Z undoes it. |
| ED-3 | If the note changes while the model is working, nothing is applied and the result is copied to the clipboard with a notice. |
| ED-4 | Instructions can name a skill, for example "rewrite this using my writing-style skill". Edit and insert may load skills and read files, but never write files themselves. |
| ED-5 | **Edit or insert with Synapse** is also a command, so users can assign a hotkey. |
| ED-6 | Folder menu: **New note** and **New canvas** from a description, **New summary note** covering every note in the folder, **Semantic search**, and **Chat with Claude Synapse**. Note menu: **Chat with Claude Synapse**. |
| ED-7 | Image menu, and an extra submenu on an editor line with an image embed: extract text below or in place, convert to a Mermaid diagram, and ask a question about the image. Image actions use the agent mapped to **Vision**. |
| ED-8 | New note, new canvas, and folder summaries run with no tools and a single turn, so they're fast and predictable. |

### 6.8 Feature map

| ID | Requirement |
|---|---|
| FM-1 | **Settings → Feature Map & Agents** sets a default agent for each feature: chat, editor actions, search, Telegram, and vision (image actions). |
| FM-2 | **Auto** (the default) uses Claude's default agent, so no feature depends on a particular agent file existing. |

### 6.9 Customization (`_synapse/`)

| ID | Requirement |
|---|---|
| CU-1 | `_synapse/` is registered as an SDK local plugin. Agents (`agents/*.md`), skills (`skills/<name>/SKILL.md`), and MCP servers (`.mcp.json`) are discovered natively, with no custom loader. |
| CU-2 | New and changed files apply on the next message, with no reload. |
| CU-3 | Agents can set description, model, tools, and skills in frontmatter. |
| CU-4 | Skills are available in every conversation and picked up when a request matches their description, or run directly with `/name`. |
| CU-5 | **Self-improve.** When the user states a lasting preference, the assistant offers to turn it into an agent or skill. `synapse-config` proposes the exact file (path, frontmatter, body) and writes it only after approval. Deletion needs a second confirmation. |
| CU-6 | Toolbar dropdowns list the vault's agents and skills from a display-only scan. |

### 6.10 Starter kit

| ID | Requirement |
|---|---|
| SK-1 | On first run in a vault without `_synapse/`, the plugin installs the **Writer** and **Search** agents and the `synapse-config`, `writing-style`, `think`, and `obsidian` skills, plus a default `settings.json`. |
| SK-2 | **Initialize** (on **Feature Map & Agents** and **Capabilities**) adds missing files and never overwrites edits. It can reset the Writer and Search agents and the `obsidian` and `synapse-config` skills to their bundled versions, confirming each one separately. `writing-style`, `think`, `settings.json`, and the user's own files are never replaced. |
| SK-3 | The `synapse-config` **setup workflow** builds writing styles from 3–5 of the user's own documents in seven steps: inventory, choose styles, collect samples, analyze (patterns seen in at least two samples), propose, write after approval, and try it. |
| SK-4 | **Writer** delivers a complete piece (essay, document, speech, or article), confirms the brief once, grounds claims in the vault or marks them as assumptions, and always loads `writing-style`. |
| SK-5 | `writing-style` uses the user's styles when one matches, otherwise one of four built-in voices (personal, technical, spoken, professional). It strips AI-sounding phrasing and never invents facts, quotes, or stories. |
| SK-6 | `think` asks one question at a time with a recommended answer, checks the vault before asking, and summarizes what was agreed. |
| SK-7 | `obsidian` covers Obsidian Flavored Markdown, Bases, and the `obsidian` CLI. |

### 6.11 Telegram bot

| ID | Requirement |
|---|---|
| TG-1 | Users connect a bot with a token (stored securely), a bot identifier, a required allowlist of numeric user IDs, and a default agent. |
| TG-2 | Messages from anyone outside the allowlist are silently ignored. |
| TG-3 | Each chat or topic has its own session. `/new` starts fresh and `/help` explains usage. Replies longer than Telegram's limit are split. |
| TG-4 | Photos, documents, audio, and video are saved to `_synapse/bot-attachments/` and passed to the agent. |
| TG-5 | Bot sessions run unattended with tool approval bypassed, independent of the global approval setting. The allowlist is the safety boundary. |
| TG-6 | The bot answers only while Obsidian is running and the bot is connected. It never connects automatically on startup. |

### 6.12 Settings

| ID | Requirement |
|---|---|
| ST-1 | Five settings pages, **Claude**, **Feature Map & Agents**, **Capabilities**, **Tools**, and **Bots**, each indexed by Obsidian's settings search. |
| ST-2 | **Capabilities** links to the optional companion theme. The plugin makes no network request for it. |
| ST-3 | Settings that affect an active session apply to the next new or reconfigured session. |

## 7. Non-functional requirements

### Platform and compatibility

- Obsidian Desktop 1.13.0 or newer. Desktop only (`isDesktopOnly: true`).
- The Claude CLI is required, including for local-model use.
- Upgrades keep settings, secrets, `_synapse/`, command IDs, and view state. The move from the
  `synapse` plugin ID to `claude-synapse` preserves vault-scoped secure keys and migrates legacy
  ones.
- Command IDs, settings keys, and `_synapse/` field names don't change without a migration path.

### Security and privacy

- Tool approval defaults to **Ask**.
- API keys, the endpoint key, and the Telegram token live in vault-scoped app local storage, never
  in `data.json`.
- The subprocess gets an allowlisted environment and doesn't receive user or host identity
  variables.
- No maintainer telemetry, analytics, crash reporting, or advertising.
- Every network destination (Anthropic through the CLI, a configured endpoint, Telegram, MCP
  servers) is user-configured and listed in
  [`COMMUNITY_DISCLOSURES.md`](../COMMUNITY_DISCLOSURES.md). The threat model is in
  [`SECURITY.md`](../SECURITY.md).
- `_synapse/.mcp.json` is treated as executable configuration, and the docs say so.

### Reliability

- The plugin's own concurrent writes to the same file are serialized by a per-file lock with a
  60-second timeout.
- Listeners, intervals, and in-flight queries are cleaned up on unload. Bot reset and disconnect
  abort in-flight queries.
- A CLI and SDK version mismatch warns but never blocks.
- Endpoint discovery failures are ignored rather than breaking startup.

### Performance

- Text transforms (new note, new canvas, folder summary) use no tools and a single turn. Edit and
  insert are limited to the `Skill` and `Read` tools and a few turns.
- The CLI model catalogue and query metadata are cached between sessions.

### Distribution and quality

- Releases are tag-triggered GitHub releases with three installer assets (`main.js`,
  `manifest.json`, `styles.css`), compatible with BRAT, and come with SLSA build-provenance
  attestations. The tag equals the manifest version, with no `v` prefix.
- TypeScript strict mode, ESLint with `eslint-plugin-obsidianmd`, and a Vitest unit suite with a
  mocked Obsidian API.

## 8. Known limitations

- A reopened conversation replays messages and reasoning, but not the tool-call blocks from the
  original turns.
- The dollar budget is reported after a run. It doesn't stop a run in flight.
- The write lock covers only the plugin's own writes, not writes the agent makes through its tools
  or manual edits.
- Telegram attachments aren't deleted automatically and may sync with the vault.
- The Telegram bot needs Obsidian running on the desktop.
- OpenAI-compatible-only servers need a gateway that speaks the Anthropic Messages API.
- Local models may need a larger context window configured on the server (see
  [Local models with Ollama](Local-Models-Ollama.md)).

## 9. Out of scope and retired features

These existed in earlier versions or were proposed, and are not part of the current product:

| Feature | Status |
|---|---|
| OpenAI-compatible provider matrix and the local ReAct loop | Removed in favor of Anthropic Messages API endpoints only ([decision](../.docs/decisions/2026-09-09-anthropic-only-provider-and-batch-loop-removal.md)) |
| Batch loops over many notes | Removed with the above |
| Editor submenu of fixed actions (Rewrite, Proofread, Summarize, and others), the multi-choice Edit dialog, and their per-action commands | Replaced in 0.4.0 by **Edit with Synapse** and **Insert with Synapse** |
| Triggers (`_synapse/triggers/`) and the run-executor pipeline | Removed. No vault-side automation exists today |
| GitHub Copilot SDK runtime | Replaced by the Claude Agent SDK ([decision](../.docs/decisions/2026-06-28-claude-agent-sdk-migration.md)) |
| Mobile support | Not planned |

## 10. Success measures

The plugin collects no telemetry, so success is judged from public and qualitative signals:

- **Adoption:** BRAT installs, GitHub stars, and, once listed, Community directory downloads.
- **Activation:** users reporting that they completed the writing-style setup workflow.
- **Customization:** issues and discussions about user-created agents, skills, and MCP servers.
- **Quality:** open bug count and time to fix, and releases shipped without regressions.
- **Parity:** local-model issues resolved without adding a separate code path.

## 11. Open questions and future directions

- **Automation without a person at the keyboard.** Watch, schedule, and batch triggers were
  removed. The [2026-09-29 automations audit](../.docs/audits/2026-09-29-automations-audit-redo.md)
  proposes rebuilding them on SDK hooks.
- **Community directory listing.** Readiness work is tracked in the
  [publishing audit](../.docs/audits/2026-09-13-obsidian-plugin-publishing-readiness.md).
- **Subagent management for local models** and **voice with local models**, explored in
  [`.docs/research/`](../.docs/research/).
- **Replaying tool-call blocks** in reopened sessions.
- **Enforcing the dollar budget** during a run, not only after it.

## Suggested reading

- [Using Claude Synapse](Using-Synapse.md): the panel, search, sessions, and editor actions
- [Customization](Customization.md): agent, skill, MCP, and settings file formats
- [Configuration](Configuration.md): every settings page
- [Architecture overview](../specs/ARCHITECTURE.md): how the modules fit together
