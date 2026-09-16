# main

Sources: `src/main.ts`, `src/tasks.ts`, `src/identityMigration.ts`.

## Startup

`SynapsePlugin.onload()` registers the custom `synapse-icon`, migrates legacy secure keys
through vault-scoped App storage, and loads settings before registering the settings tab,
`SYNAPSE_VIEW_TYPE` view factory, ribbon, commands, and editor/file context menus.

Starter-kit installation is deferred to `workspace.onLayoutReady()`. It runs only if
`_synapse/` is absent; installation errors are logged. Settings initialization can restore
individual missing files later (see [config-writer.md](config-writer.md)).

Startup initializes `AgentService`, checks CLI readiness, and requests the CLI model catalogue.
Failures are logged; missing-binary/spawn errors additionally show a 30-second installation
Notice. Readiness validates API-key presence and binary existence, rather than performing a
provider authentication round trip.

## Service and model wiring

`initAgentService()` stops the previous service and constructs a replacement from auth,
CLI-location, and optional local-endpoint settings. `stop()` only resets service readiness;
it does not track or abort existing queries.

Endpoint catalogue discovery is fire-and-forget. A successful non-empty result reaches
`setProviderModels()` and `AgentService.setCustomModels()`. Both initial and discovered model
lists are broadcast to every open Synapse view through `refreshProviderModels()`. The async
catalogue callback uses the plugin's current service rather than retaining the originating one.

## Commands and view activation

Registered command IDs are `open-chat`, `chat-with-synapse`, `edit-note`,
`structure-and-refine`, `edit-selection`, and one `text-action-<slug>` per `TASKS` entry.
Slugs are lowercased task labels with whitespace replaced by hyphens. Selection commands
use the active CM6 editor; text actions require a non-empty selection.

`activateView()` reveals the first existing Synapse leaf, or creates the view in the right
sidebar. Selection chat includes file and line/character context. Editor action behavior
is covered in [editor.md](editor.md).

## Settings and identity

`loadSettings()` merges defaults with persisted data, separately merges `featureAgents`,
removes the retired provider-matrix keys, and migrates plaintext secrets into vault-scoped
App storage without replacing existing non-empty stored values. Runtime settings load those
stored secrets; `saveSettings()` writes empty strings for the secure fields in `data.json`.

The manifest identity is `claude-synapse`; `_synapse/`, view types, command IDs, and
`synapse-secure-` keys remain stable. Legacy `claude-brain-secure-` values migrate only
when the destination is null/absent, after which the legacy key is cleared. Folder migration
between installed plugin IDs is a user operation, not performed by this module.

## Telegram and unload

Telegram connects only through an explicit `connectTelegram()` call, which requires a token
and lazily creates `TelegramBotService`. The bot additionally requires an allowlist.
`disconnectTelegram()` delegates to the bot; startup does not automatically connect it.

`onunload()` requests service stop, schedules release of the plugin's timer-shim reference,
and disconnects Telegram. Chat/search query cleanup belongs to `SynapseView.onClose()`;
`AgentService.stop()` itself does not terminate those queries. See [agent-service.md](agent-service.md)
and [bots.md](bots.md).
