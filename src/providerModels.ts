import {requestUrl, type App} from 'obsidian';
import type {ModelInfo} from './agentService';

export interface LocalToolCall {
	id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string | Record<string, unknown>;
	};
}

export interface LocalTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (args: Record<string, unknown>, app: App) => Promise<string>;
}

/**
 * Context handed to a `LocalToolApprovalHandler` alongside the tool name/input, naming the
 * endpoint the call is going to (#138) — a tool call against a loopback Ollama instance stays on
 * this machine, but the same `executeLocalProviderQuery` code path also serves BYOK remote
 * endpoints (OpenAI, Azure, OpenRouter, ...), where a read-only vault tool's result is genuinely
 * sent to a third party. `isRemoteEndpoint` lets the caller-supplied approval prompt say which
 * case this is instead of showing the same prompt either way.
 */
export interface LocalToolApprovalContext {
	/** Identifies this specific tool call, for callers that need to correlate/dedupe prompts. */
	toolUseID: string;
	/** The base URL this tool call's request (and thus, for a vault tool, note content) goes to. */
	endpoint: string;
	/** True when `endpoint` is not a loopback address. */
	isRemoteEndpoint: boolean;
}

/**
 * Approval gate for the local tool-execution loop (#138). Deliberately neutral (no SDK or view
 * types) so this module stays free of both — the caller (`agentService.ts#Session.send()`)
 * adapts the chat panel's existing `canUseTool` (`CanUseTool` from the Agent SDK, built in
 * `SynapseView.buildSessionConfig()` and already opening `ToolApprovalModal`) into this shape,
 * the same way `history` was threaded in as a plain callback/value for #135 rather than importing
 * `ChatMessage`. Returning `{allow: false}` denies the call; `message` (optional) is surfaced to
 * the model as the tool's result so it knows the call was declined, not that it errored.
 */
export type LocalToolApprovalHandler = (
	toolName: string,
	input: Record<string, unknown>,
	context: LocalToolApprovalContext
) => Promise<{allow: boolean; message?: string}>;

/**
 * True when `baseUrl`'s host is a loopback address (`localhost`, `127.0.0.1`, `::1`) — i.e. the
 * request never leaves this machine. Used only to label the approval prompt (#138); an
 * unparseable URL is treated as remote (the more cautious label), not silently skipped.
 */
export function isLoopbackEndpoint(baseUrl: string): boolean {
	try {
		const {hostname} = new URL(baseUrl);
		const h = hostname.toLowerCase();
		return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
	} catch {
		return false;
	}
}

/**
 * Neutral wire-agnostic history entry for `executeLocalProviderQuery()`'s conversation-history
 * parameter (#135). Deliberately not `ChatMessage` (`types.ts`) — this module must not import
 * view types, so the mapping from `ChatMessage` to this shape lives at the call site
 * (`agentService.ts` / `synapseView.ts`), not here. Only `user`/`assistant` turns are
 * representable: `ChatMessage` carries no tool-call fields, so prior tool calls/results cannot
 * be reconstructed, and replaying partial tool state would also break OpenAI-compatible APIs
 * (a `tool` message needs a `tool_call_id` matching an immediately preceding assistant
 * `tool_calls` entry that this history has no way to supply). Callers must exclude
 * `role: 'info'` entries and must not replay `reasoning` as `content`.
 */
export interface LocalHistoryMessage {
	role: 'user' | 'assistant';
	content: string;
	images?: Array<{mimeType: string; base64: string}>;
}

export type ProviderPreset = 'ollama' | 'openai' | 'azure';

/**
 * Legacy `providerPreset` values from older `data.json` files, collapsed into the three
 * surviving presets (#117). `other-openai` and `foundry-local` were byte-identical to
 * `openai` in `fetchProviderModels`/`executeLocalProviderQuery` — no behaviour changes.
 * `anthropic` also maps to `openai`, but changes which API key drives chat (previously
 * `providerApiKey` via the hand-rolled local-provider loop; now none, until the user
 * reconfigures) — callers migrating this value should surface that to the user once.
 */
const LEGACY_PROVIDER_PRESET_MAP: Record<string, ProviderPreset> = {
	'other-openai': 'openai',
	'foundry-local': 'openai',
	'anthropic': 'openai',
};

export interface ProviderPresetMigrationResult {
	preset: ProviderPreset;
	/** True when the stored value was a legacy alias and had to be remapped. */
	migrated: boolean;
	/** True specifically when the legacy value was `anthropic` — callers should notify the user. */
	wasAnthropic: boolean;
}

/**
 * Resolves a possibly-legacy `providerPreset` value (as read from `data.json`) to one of
 * the three current presets. Silent for `other-openai`/`foundry-local`; callers should show
 * a one-time notice when `wasAnthropic` is true, since that migration changes which key
 * drives chat (see `.docs/specs/settings.md`).
 *
 * An absent/empty/whitespace-only value is **not** a legacy alias — it means no
 * `providerPreset` was ever persisted (fresh install, or a `data.json` that predates this
 * setting), and `migrated: false` here tells the caller to leave `DEFAULT_SETTINGS`'s
 * `'ollama'` default untouched rather than overwriting it with the generic-unknown fallback
 * (issue #117 review round 1 — a prior version of this function conflated "nothing stored"
 * with "unrecognized legacy string" and silently defaulted fresh installs to `openai`).
 */
export function migrateProviderPreset(value: string | undefined | null): ProviderPresetMigrationResult {
	const raw = (value || '').trim().toLowerCase();
	if (!raw) {
		return {preset: 'ollama', migrated: false, wasAnthropic: false};
	}
	if (raw === 'ollama' || raw === 'openai' || raw === 'azure') {
		return {preset: raw, migrated: false, wasAnthropic: false};
	}
	const mapped = LEGACY_PROVIDER_PRESET_MAP[raw];
	if (mapped) {
		return {preset: mapped, migrated: true, wasAnthropic: raw === 'anthropic'};
	}
	// Genuinely unrecognized non-empty value (corrupted or from a future version): fall back
	// to the generic path, matching the `options.preset || 'openai'` default used elsewhere
	// in this module.
	return {preset: 'openai', migrated: true, wasAnthropic: false};
}

/**
 * Two predictable wrong inputs for the `azure` preset's base URL, both of which Synapse's URL
 * builder (`{base}/v1/models` at `:251`, `{base}/v1/chat/completions` at `:472` — both strip
 * trailing slashes then special-case a base that already ends in `/v1`) can never turn into a
 * working request:
 *
 * 1. A **classic deployment-scoped URL**
 *    (`.../openai/deployments/<deployment>/chat/completions?api-version=...`) — flagged by a
 *    `/deployments/` path segment or an `api-version=` query param.
 * 2. The **bare portal Endpoint** (`https://<resource>.openai.azure.com/`, no path, or empty
 *    path) — this is what the Azure portal actually shows and copies to the clipboard, so it's
 *    the *more* likely paste, not a corner case. It needs the `/openai` suffix appended to reach
 *    the v1 API.
 *
 * Both `.../openai` **and** `.../openai/v1` (each with or without a trailing slash) are
 * genuinely working base URLs — the builder's own `endsWith('/v1')` special-case makes both
 * resolve to the same `.../openai/v1/...` request, so the path check below accepts both; only a
 * path that is empty or `/` (or already matched the deployment fingerprint above) gets flagged.
 * Host-matching `*.openai.azure.com` runs first so a preset pointed at some other proxy/gateway
 * is never second-guessed about a shape this module can't verify.
 *
 * Either case gets a message naming its specific fix instead of a bare "Test failed: HTTP 404".
 * Returns `null` when neither fingerprint matches — including an empty/whitespace URL, since
 * `fetchProviderModels` already reports that case with "Base URL is required.".
 */
export function describeAzureBaseUrlIssue(baseUrl: string): string | null {
	const trimmed = (baseUrl || '').trim();
	if (!trimmed) return null;

	if (/\/deployments\//i.test(trimmed) || /[?&]api-version=/i.test(trimmed)) {
		return 'That looks like a classic Azure deployment URL. Use the v1 API base URL instead: https://<resource>.openai.azure.com/openai';
	}

	try {
		const url = new URL(trimmed);
		const isAzureHost = /\.openai\.azure\.com$/i.test(url.hostname);
		const hasOpenaiSuffix = /^\/openai(\/v1)?\/?$/i.test(url.pathname);
		if (isAzureHost && !hasOpenaiSuffix) {
			return 'That looks like the Azure resource\'s Endpoint from the portal. Append /openai to it — the v1 API base URL is https://<resource>.openai.azure.com/openai';
		}
	} catch {
		// Not a parseable absolute URL — leave it to fetchProviderModels()'s request failure.
	}

	return null;
}

export interface ProviderConfigOptions {
	// `(string & {})` (not bare `string`) keeps editor autocomplete for the known
	// ProviderPreset literals while still accepting arbitrary strings — a bare
	// `string` union collapses the literals and loses that (and trips
	// @typescript-eslint/no-redundant-type-constituents).
	preset: ProviderPreset | (string & {});
	baseUrl: string;
	apiKey?: string;
	bearerToken?: string;
}

export type FetchProviderModelsResult =
	| {ok: true; models: ModelInfo[]}
	| {ok: false; error: string; isOllamaConnectionError?: boolean};

const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high'];

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Tightened from the pre-#129 `/o1|o3/i` test, which substring-matched the letter "o" followed
 * by the digit "1" or "3" anywhere in an id — over-matching (any id happening to contain that
 * two-character run) with no guarantee of actually catching OpenAI's reasoning family either.
 * This only matches OpenAI's real `o1`/`o3` naming (`o1`, `o1-mini`, `o1-preview`,
 * `openai/o3-mini`, …): the token must start the id or immediately follow a `/`, and must itself
 * be immediately followed by `-` or the end of the string — never a substring mid-word.
 */
const HEURISTIC_REASONING_ID_PATTERN = /(?:^|\/)o[13](?:-|$)/i;

/** Unchanged pre-#129 fixed-allowlist heuristic — still used, but now strictly as the last
 *  resort for catalogues that publish no modality metadata at all (see
 *  `deriveCatalogueCapabilities` below). */
const HEURISTIC_VISION_ID_PATTERN = /gpt-4o|gpt-4-vision|claude-3|gemini-1\.5|vision|pixtral/i;

interface CatalogueModelListItem {
	id?: string;
	name?: string;
	/** OpenAI-compatible catalogues may publish real capability metadata on top of the bare
	 *  `{id, object, created, owned_by}` shape. Field names verified against a live
	 *  `GET https://openrouter.ai/api/v1/models` response (2026-09-03, #129) — read generically
	 *  here (not gated on `preset` or hostname) so any backend publishing the same field names
	 *  on its model objects benefits, not just OpenRouter. */
	supported_parameters?: unknown;
	architecture?: {input_modalities?: unknown};
	reasoning?: {supported_efforts?: unknown};
}

interface DerivedCapabilities {
	isVision: boolean;
	supportsTools: boolean;
	supportsReasoning: boolean;
	reasoningEfforts: string[];
}

/**
 * Derives per-model capability flags for a `/v1/models` catalogue entry.
 *
 * Metadata-first, per field independently — a catalogue entry may publish some capability
 * fields and omit others (a "partial" catalogue); each capability falls back to a name-based
 * guess only when its own field is absent, not when the model object as a whole lacks metadata:
 *   - `supported_parameters: string[]` — presence of `'tools'` means the model accepts an
 *     OpenAI-style `tools` array on chat requests; presence of `'reasoning'` or
 *     `'reasoning_effort'` means it accepts a reasoning-effort request parameter.
 *   - `architecture.input_modalities: string[]` — presence of `'image'` means vision input.
 *   - `reasoning.supported_efforts: string[]` — the model's own advertised effort levels, used
 *     verbatim instead of the generic three-level fallback list when present.
 *
 * `supportsTools` distinguishes "authoritatively unsupported" from "unknown", rather than
 * collapsing both into the same flag:
 *   - `supported_parameters` present and lacking `'tools'` → `false`. The catalogue said no; this
 *     is the real new behaviour #129 asked for, replacing the old unconditional `true`.
 *   - `supported_parameters` absent entirely → `true` (optimistic, unchanged from before this
 *     change). A bare OpenAI-shaped `{id, object, created, owned_by}` catalogue — which is what
 *     OpenAI's own `/v1/models` and Azure's `/openai/v1/models` both return, i.e. the common case
 *     for the two flagship presets, not an edge case — carries no information either way, and
 *     `triggerExecutor.ts`'s `supportsTools = modelInfo?.supportsTools !== false` treats anything
 *     but a hard `false` as "equip the model with vault tools and start the MCP bridge". Defaulting
 *     unknown to `false` would silently strip every trigger's tools with no error on exactly the
 *     backends most users are on — a worse, less debuggable failure than the opaque call-time
 *     tool-call rejection an over-eager `true` risks on the minority of backends that both omit
 *     this field and genuinely can't call tools. Ollama's own `false` default is not a
 *     counter-example: it is backed by a per-model `/api/show` call, i.e. a *confirmed* answer,
 *     not an absent one, so it isn't the same state as a catalogue that publishes nothing.
 */
function deriveCatalogueCapabilities(item: CatalogueModelListItem, id: string): DerivedCapabilities {
	const rawSupportedParams = item.supported_parameters;
	const supportedParams = isStringArray(rawSupportedParams) ? rawSupportedParams : undefined;

	const rawInputModalities = item.architecture?.input_modalities;
	const inputModalities = isStringArray(rawInputModalities) ? rawInputModalities : undefined;

	const rawReasoningEfforts = item.reasoning?.supported_efforts;
	const catalogueReasoningEfforts = isStringArray(rawReasoningEfforts) ? rawReasoningEfforts : undefined;

	const isVision = inputModalities
		? inputModalities.includes('image')
		: HEURISTIC_VISION_ID_PATTERN.test(id);

	const supportsTools = supportedParams
		? supportedParams.includes('tools')
		: true;

	const supportsReasoning = supportedParams
		? (supportedParams.includes('reasoning') || supportedParams.includes('reasoning_effort'))
		: HEURISTIC_REASONING_ID_PATTERN.test(id);

	return {
		isVision,
		supportsTools,
		supportsReasoning,
		reasoningEfforts: (supportsReasoning && catalogueReasoningEfforts) ? catalogueReasoningEfforts : DEFAULT_REASONING_EFFORTS,
	};
}

const ollamaShowCache = new Map<string, {vision?: boolean; tools?: boolean; contextLength?: number}>();

/**
 * Cache key is `baseUrl + '\0' + modelId`, not the model id alone (#120) — the same model
 * name (e.g. `llama3.1`) can exist on two different Ollama hosts with different capability
 * metadata, and keying on id alone served stale capabilities from whichever host was queried
 * first after a `baseUrl` switch.
 */
function ollamaShowCacheKey(baseUrl: string, id: string): string {
	return `${baseUrl}\0${id}`;
}

export function clearOllamaShowCache(): void {
	ollamaShowCache.clear();
}

/**
 * Small bound-concurrency mapper for `/api/show` calls (#120): running all of them serially
 * turns a 20-model library into 20 sequential round-trips; running them fully unbounded could
 * flood the local daemon. `limit` caps how many are in flight at once while still letting each
 * task fail independently — a slow/failing `/api/show` for one model must not affect the rest.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const worker = async () => {
		while (nextIndex < items.length) {
			const i = nextIndex++;
			const item = items[i] as T;
			results[i] = await fn(item);
		}
	};
	const workers = Array.from({length: Math.min(limit, items.length)}, () => worker());
	await Promise.all(workers);
	return results;
}

export async function fetchProviderModels(options: ProviderConfigOptions): Promise<FetchProviderModelsResult> {
	const preset = (options.preset || 'openai').toLowerCase();
	let baseUrl = (options.baseUrl || '').trim();
	if (!baseUrl) {
		return {ok: false, error: 'Base URL is required.'};
	}

	const token = options.bearerToken || options.apiKey || '';

	if (preset === 'ollama') {
		baseUrl = baseUrl.replace(/\/+$/, '');
		if (baseUrl.endsWith('/v1')) {
			baseUrl = baseUrl.slice(0, -3).replace(/\/+$/, '');
		}
		const tagsUrl = `${baseUrl}/api/tags`;

		const headers: Record<string, string> = {};
		if (token) {
			headers['Authorization'] = `Bearer ${token}`;
		}

		try {
			const res = await requestUrl({url: tagsUrl, headers, throw: false});
			if (res.status >= 400) {
				return {ok: false, error: `HTTP ${res.status}`};
			}
			const data = res.json as {
				models?: Array<{
					name?: string;
					model?: string;
					details?: {family?: string; families?: string[]};
				}>;
			};

			const rawModels = data.models || [];

			const models = await mapWithConcurrency(rawModels, 5, async (item): Promise<ModelInfo | null> => {
				const id = item.name || item.model || '';
				if (!id) return null;
				const name = item.name || item.model || id;

				const familyList = [
					item.details?.family,
					...(item.details?.families || [])
				]
					.filter(Boolean)
					.map((s) => (s as string).toLowerCase());
				const nameLower = id.toLowerCase();

				let isVision =
					familyList.includes('mllama') ||
					familyList.includes('clip') ||
					/vision|llava|minicpm|moondream|gemma3/.test(nameLower);
				let supportsTools = false;

				const cacheKey = ollamaShowCacheKey(baseUrl, id);
				const cached = ollamaShowCache.get(cacheKey);
				if (cached) {
					if (cached.vision !== undefined) isVision = cached.vision;
					if (cached.tools !== undefined) supportsTools = cached.tools;
				} else {
					try {
						const showUrl = `${baseUrl}/api/show`;
						const showRes = await requestUrl({
							url: showUrl,
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
								...headers
							},
							body: JSON.stringify({model: id}),
							throw: false,
						});
						if (showRes.status < 400) {
							const showData = showRes.json as {
								capabilities?: string[];
							};
							const caps = showData.capabilities || [];
							if (Array.isArray(caps)) {
								if (caps.includes('vision')) isVision = true;
								if (caps.includes('tools')) supportsTools = true;
								ollamaShowCache.set(cacheKey, {
									vision: caps.includes('vision'),
									tools: caps.includes('tools')
								});
							}
						}
					} catch {
						// ignore /api/show network errors, rely on heuristic
					}
				}

				return {
					id,
					name,
					capabilities: {
						supports: {
							vision: isVision,
							tools: supportsTools
						}
					},
					isVision,
					supportsTools
				};
			});

			return {ok: true, models: models.filter((m): m is ModelInfo => m !== null)};
		} catch (e) {
			return {
				ok: false,
				error: String(e),
				isOllamaConnectionError: true
			};
		}
	} else {
		baseUrl = baseUrl.replace(/\/+$/, '');
		const modelsUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/models` : `${baseUrl}/v1/models`;

		const headers: Record<string, string> = {};
		if (token) {
			if (preset === 'azure') {
				headers['api-key'] = token;
			} else {
				headers['Authorization'] = `Bearer ${token}`;
			}
		}

		try {
			const res = await requestUrl({url: modelsUrl, headers, throw: false});
			if (res.status >= 400) {
				return {ok: false, error: `HTTP ${res.status}`};
			}
			const data = res.json as {data?: CatalogueModelListItem[]} | CatalogueModelListItem[];

			const rawModels: CatalogueModelListItem[] = !Array.isArray(data) && Array.isArray(data.data)
				? data.data
				: Array.isArray(data) ? data : [];
			const models: ModelInfo[] = [];

			for (const item of rawModels) {
				const id = item.id || '';
				if (!id) continue;
				const name = item.name || id;

				const {isVision, supportsTools, supportsReasoning, reasoningEfforts} = deriveCatalogueCapabilities(item, id);

				models.push({
					id,
					name,
					capabilities: {
						supports: {
							vision: isVision,
							reasoningEffort: supportsReasoning,
							tools: supportsTools
						},
						supportedReasoningEfforts: supportsReasoning ? reasoningEfforts : undefined
					},
					isVision,
					supportsTools
				});
			}

			return {ok: true, models};
		} catch (e) {
			return {ok: false, error: String(e)};
		}
	}
}

export type LocalQueryResult =
	| {ok: true; content: string; truncated?: boolean}
	| {ok: false; error: string};

/**
 * Character-per-token divisor used to turn a token-based context length into a character
 * budget for conversation history (#135). Deliberately conservative (i.e. low): ~4 chars/token
 * is a reasonable average for English prose, but code and CJK text run closer to 2-3
 * chars/token, and under-budgeting (leaving headroom) is far cheaper than over-budgeting
 * (silently overflowing the model's real window).
 */
const HISTORY_CHARS_PER_TOKEN = 3;

/**
 * Fixed fallback (chars) for the history budget when **no context-length signal is available at
 * all** — a backend that publishes nothing (OpenAI/Azure-compatible catalogues don't carry
 * context length in the `/v1/models` shape this module reads) or an `/api/show` call that
 * failed/returned nothing. This is a signal-less middle-ground guess, not a safety guarantee:
 * ~2.7k tokens at the divisor above can still exceed a small local `num_ctx` (commonly
 * 2048-4096 on Ollama) on its own, before the system prompt, current turn, and response are even
 * counted. It is used *only* in the no-signal case — whenever a real context length is known
 * (`computeHistoryCharBudget`'s `advertisedContextLengthTokens` branch), that measured value is
 * trusted directly instead of being floored up to this constant, since a small measured window is
 * the strongest possible reason to shrink the budget, not override it.
 */
const DEFAULT_HISTORY_CHAR_BUDGET = 8000;

/**
 * Small floor on the computed (not the fallback) budget — guards only against a technically
 * nonzero but useless sliver (e.g. a handful of chars) when an advertised context length is
 * tiny, not a target to reach for. Deliberately much smaller than
 * `DEFAULT_HISTORY_CHAR_BUDGET`: this floor applies precisely when a real signal says the window
 * is small, so honoring that signal (even down to "basically no history") is the safe behaviour,
 * not overriding it upward.
 */
const MIN_HISTORY_CHAR_BUDGET = 500;

/**
 * Hard ceiling on the history budget regardless of how large a model's advertised context length
 * is. Prevents a single huge advertised max (see the `/api/show` caveat below) from producing an
 * enormous request even after the safety fraction is applied.
 */
const MAX_HISTORY_CHAR_BUDGET = 24000;

/**
 * Fraction of a model's *advertised* (`/api/show` `model_info["*.context_length"]`) maximum
 * context length actually used to size the history budget. Deliberately small: Ollama defaults
 * `num_ctx` (the server's *effective* context window for a request) to a few thousand tokens
 * regardless of what the model itself can technically support, silently truncating the oldest
 * tokens off the request when it's exceeded — no error, unlike OpenAI-compatible backends' HTTP
 * 400 on overflow. The advertised max is therefore only ever a ceiling to stay well under, not
 * headroom to spend: it accounts for the system prompt, the current turn (which may itself carry
 * inlined attachment text), and the model's response, none of which this budget (history only)
 * otherwise reserves for. This fraction must actually bind for small windows too — see
 * `computeHistoryCharBudget()`, which trusts a known context length directly rather than
 * flooring it up to `DEFAULT_HISTORY_CHAR_BUDGET`.
 */
const OLLAMA_CONTEXT_SAFETY_FRACTION = 0.25;

/**
 * Sizes the character budget for conversation history from a model's advertised context length
 * (tokens), when known. See `OLLAMA_CONTEXT_SAFETY_FRACTION` for why this stays well under the
 * advertised max rather than treating it as available headroom, and `DEFAULT_HISTORY_CHAR_BUDGET`
 * for the fallback when no context-length signal is available.
 */
function computeHistoryCharBudget(advertisedContextLengthTokens?: number): number {
	if (!advertisedContextLengthTokens || advertisedContextLengthTokens <= 0) {
		return DEFAULT_HISTORY_CHAR_BUDGET;
	}
	const safeTokens = advertisedContextLengthTokens * OLLAMA_CONTEXT_SAFETY_FRACTION;
	const chars = Math.floor(safeTokens * HISTORY_CHARS_PER_TOKEN);
	// Trust a known context length directly — clamped only to MIN/MAX_HISTORY_CHAR_BUDGET, never
	// floored up to DEFAULT_HISTORY_CHAR_BUDGET. Flooring a *measured* small window up to the
	// signal-less fallback would silently exceed it (e.g. an 8000-char floor is already ~130% of
	// a 2048-token window before the system prompt/current turn/response are even counted) —
	// exactly the silent-overflow failure this budget exists to prevent.
	return Math.max(MIN_HISTORY_CHAR_BUDGET, Math.min(chars, MAX_HISTORY_CHAR_BUDGET));
}

/**
 * Drops whole history messages from the oldest end until the remaining set fits within
 * `budgetChars` (#135). Never truncates mid-message and never drops the system message (which
 * isn't part of `history` at all — callers push it separately, unconditionally). The single
 * newest history message is always kept even if it alone exceeds the budget: splitting it is
 * off the table, and dropping the entire history to zero would defeat the point more than
 * slightly overshooting the budget on an unavoidable single oversized turn.
 *
 * Exported (#137) for reuse by `view/sessionConfig.ts#buildSdkHistoryInjection` — the same
 * oldest-first-drop-whole-messages policy also bounds the transcript injected into an Agent SDK
 * prompt to bridge turns the CLI's own session never saw (local-provider turns), just sized with
 * a different, much larger budget appropriate to Claude's context window rather than a local
 * model's — see that function's doc comment.
 */
export function buildBudgetedHistory(history: LocalHistoryMessage[], budgetChars: number): LocalHistoryMessage[] {
	const kept: LocalHistoryMessage[] = [];
	let total = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		const msg = history[i] as LocalHistoryMessage;
		const len = msg.content.length;
		if (kept.length > 0 && total + len > budgetChars) {
			break;
		}
		kept.unshift(msg);
		total += len;
	}
	return kept;
}

/**
 * Reads a model's advertised maximum context length (tokens) from Ollama's `/api/show`, which
 * `fetchProviderModels()` already calls per-model for vision/tools capability discovery (`:296`
 * onward) — this reuses the same endpoint and cache (`ollamaShowCache`), keyed the same way
 * (`baseUrl + '\0' + model`, #120), just reading a different field off the same response
 * (`model_info`). The key name for context length varies by model architecture
 * (`llama.context_length`, `qwen2.context_length`, ...), so this scans for any `model_info` key
 * ending in `.context_length` rather than hardcoding one family's key. Returns `undefined` (not
 * a guess) on any failure — `computeHistoryCharBudget()` falls back to the fixed conservative
 * default in that case, per #135's decision to fall back rather than invent a number.
 */
async function getOllamaContextLength(baseUrl: string, model: string, headers: Record<string, string>): Promise<number | undefined> {
	const cacheKey = ollamaShowCacheKey(baseUrl, model);
	const cached = ollamaShowCache.get(cacheKey);
	if (cached && cached.contextLength !== undefined) {
		return cached.contextLength;
	}
	try {
		const showUrl = `${baseUrl}/api/show`;
		const showRes = await requestUrl({
			url: showUrl,
			method: 'POST',
			headers: {'Content-Type': 'application/json', ...headers},
			body: JSON.stringify({model}),
			throw: false,
		});
		if (showRes.status >= 400) return undefined;
		const showData = showRes.json as {model_info?: Record<string, unknown>};
		const info = showData.model_info || {};
		let contextLength: number | undefined;
		for (const [key, value] of Object.entries(info)) {
			if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
				contextLength = value;
				break;
			}
		}
		ollamaShowCache.set(cacheKey, {...cached, contextLength});
		return contextLength;
	} catch {
		// Ignore /api/show network errors — caller falls back to the conservative fixed default.
		return undefined;
	}
}

/**
 * Builds a single wire-format chat message, handling the same Ollama-vs-OpenAI-compatible image
 * shape difference for any role/turn (#135 extends the current-turn-only handling this was
 * factored out of to also cover history entries — see the doc comment at this function's call
 * sites below for the shape details).
 */
function buildLocalWireMessage(
	role: 'user' | 'assistant',
	text: string,
	images: Array<{mimeType: string; base64: string}> | undefined,
	preset: string
): {role: string; content: string | Array<{type: string; text?: string; image_url?: {url: string}}>; images?: string[]} {
	if (images && images.length > 0) {
		if (preset === 'ollama') {
			return {role, content: text, images: images.map(img => img.base64)};
		}
		const content: Array<{type: string; text?: string; image_url?: {url: string}}> = [{type: 'text', text}];
		for (const img of images) {
			content.push({type: 'image_url', image_url: {url: `data:${img.mimeType};base64,${img.base64}`}});
		}
		return {role, content};
	}
	return {role, content: text};
}

export function isLocalBackendConfigured(options?: ProviderConfigOptions): boolean {
	return Boolean(options && options.baseUrl && options.baseUrl.trim().length > 0);
}

let cachedDefaultModel: {baseUrl: string; model: string} | null = null;

export function clearCachedDefaultModel(): void {
	cachedDefaultModel = null;
}

async function resolveDefaultModel(options: ProviderConfigOptions): Promise<string> {
	const baseUrl = (options.baseUrl || '').trim();
	if (cachedDefaultModel && cachedDefaultModel.baseUrl === baseUrl) {
		return cachedDefaultModel.model;
	}
	const modelsRes = await fetchProviderModels(options);
	const firstModel = modelsRes.ok && modelsRes.models.length > 0 ? modelsRes.models[0] : undefined;
	const preset = (options.preset || 'openai').toLowerCase();
	const model = firstModel ? firstModel.id : (preset === 'ollama' ? 'llama3' : 'gpt-3.5-turbo');
	cachedDefaultModel = {baseUrl, model};
	return model;
}

export async function executeLocalProviderQuery(
	options: ProviderConfigOptions,
	params: {
		prompt: string;
		systemPrompt?: string;
		model?: string;
		tools?: LocalTool[];
		app?: App;
		maxTurns?: number;
		images?: Array<{mimeType: string; base64: string}>;
		/**
		 * Prior conversation turns (#135), oldest first. Optional and omitted by one-shot
		 * callers (triggers, inline edits, the in-process delegation tools) that have no
		 * ongoing conversation to carry — see `.docs/specs/agent-service.md` "BYOK local
		 * provider conversation history" for which call sites pass this and why. Budgeted to a
		 * character budget (see `computeHistoryCharBudget`) and mapped to wire messages the
		 * same way the current turn is.
		 */
		history?: LocalHistoryMessage[];
		/**
		 * Approval gate consulted before each tool call executes (#138). Optional and omitted by
		 * the trigger path (`triggerExecutor.ts`), which runs unattended by design and is
		 * unchanged by this parameter — when absent, a tool call runs immediately, exactly as
		 * before. The chat panel (`agentService.ts#Session.send()`) always supplies one so
		 * interactive tool use is consented to the same way the Agent SDK path already gates it.
		 */
		onApproveTool?: LocalToolApprovalHandler;
	}
): Promise<LocalQueryResult> {
	const baseUrl = (options.baseUrl || '').trim();
	if (!baseUrl) {
		return {ok: false, error: 'Local backend base URL is not configured.'};
	}

	const preset = (options.preset || 'openai').toLowerCase();
	const token = options.bearerToken || options.apiKey || '';

	const targetModel = params.model || await resolveDefaultModel(options);

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (token) {
		if (preset === 'azure') {
			headers['api-key'] = token;
		} else {
			headers['Authorization'] = `Bearer ${token}`;
		}
	}

	const apiTools = params.tools?.map(t => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters
		}
	}));

	// Ollama's native /api/chat endpoint (used below when preset === 'ollama') does not accept
	// OpenAI-style `content: [{type: 'image_url', ...}]` arrays — it expects `content: string`
	// plus a sibling `images: string[]` (raw base64, no data: URI prefix) on the message.
	// Every other preset goes through an OpenAI-compatible /v1/chat/completions endpoint, which
	// does accept the `image_url` content-part array. `buildLocalWireMessage()` builds whichever
	// shape matches the target endpoint for both history entries and the current turn; calls
	// with no images keep the existing plain-string content unchanged either way.
	type MessageContent = string | Array<{type: string; text?: string; image_url?: {url: string}}>;
	const messages: Array<{role: string; content: MessageContent; images?: string[]; tool_calls?: LocalToolCall[]; tool_call_id?: string; name?: string}> = [];
	if (params.systemPrompt) {
		messages.push({role: 'system', content: params.systemPrompt});
	}

	// Conversation history (#135): character-budgeted, oldest messages dropped whole first, system
	// message always kept (it isn't part of `history` — pushed unconditionally above). The budget
	// is sized from the model's advertised context length when we can get one (Ollama's
	// `/api/show`); every other backend, and any failed lookup, falls back to a fixed conservative
	// default — see `computeHistoryCharBudget()`/`getOllamaContextLength()`.
	if (params.history && params.history.length > 0) {
		const contextLength = preset === 'ollama'
			? await getOllamaContextLength(baseUrl, targetModel, headers)
			: undefined;
		const budgetChars = computeHistoryCharBudget(contextLength);
		const budgetedHistory = buildBudgetedHistory(params.history, budgetChars);
		for (const entry of budgetedHistory) {
			messages.push(buildLocalWireMessage(entry.role, entry.content, entry.images, preset));
		}
	}

	messages.push(buildLocalWireMessage('user', params.prompt, params.images, preset));

	let turn = 0;
	const maxTurns = params.maxTurns ?? 5;
	let latestContent = '';
	let lastNonEmptyContent = '';

	try {
		while (turn < maxTurns) {
			const requestBody: {
				model: string;
				messages: Array<{
					role: string;
					content: MessageContent;
					images?: string[];
					tool_calls?: LocalToolCall[];
					tool_call_id?: string;
					name?: string;
				}>;
				stream?: boolean;
				tools?: Array<{
					type: string;
					function: {
						name: string;
						description: string;
						parameters: Record<string, unknown>;
					};
				}>;
			} = {
				model: targetModel,
				messages,
			};
			if (preset === 'ollama') {
				requestBody.stream = false;
			}
			if (apiTools && apiTools.length > 0) {
				requestBody.tools = apiTools;
			}

			let responseMessage: {
				role?: string;
				content?: string;
				tool_calls?: LocalToolCall[];
			} | undefined;
			let toolCalls: LocalToolCall[] | undefined;

			if (preset === 'ollama') {
				const tempBase = baseUrl.replace(/\/+$/, '');
				const cleanBase = tempBase.endsWith('/v1') ? tempBase.slice(0, -3).replace(/\/+$/, '') : tempBase;
				const chatUrl = `${cleanBase}/api/chat`;
				const res = await requestUrl({
					url: chatUrl,
					method: 'POST',
					headers,
					body: JSON.stringify(requestBody),
					throw: false,
				});
				if (res.status >= 400) {
					return {ok: false, error: `Ollama error: HTTP ${res.status}`};
				}
				const data = res.json as {
					message?: {
						role?: string;
						content?: string;
						tool_calls?: LocalToolCall[];
					};
				};
				responseMessage = data.message;
				toolCalls = responseMessage?.tool_calls;
			} else {
				const tempBase = baseUrl.replace(/\/+$/, '');
				const chatUrl = tempBase.endsWith('/v1') ? `${tempBase}/chat/completions` : `${tempBase}/v1/chat/completions`;
				const res = await requestUrl({
					url: chatUrl,
					method: 'POST',
					headers,
					body: JSON.stringify(requestBody),
					throw: false,
				});
				if (res.status >= 400) {
					return {ok: false, error: `Provider error: HTTP ${res.status}`};
				}
				const data = res.json as {
					choices?: Array<{
						message?: {
							role?: string;
							content?: string;
							tool_calls?: LocalToolCall[];
						};
					}>;
				};
				responseMessage = data.choices?.[0]?.message;
				toolCalls = responseMessage?.tool_calls;
			}

			if (!responseMessage) {
				return {ok: false, error: 'Empty response from model provider.'};
			}

			latestContent = responseMessage.content || '';
			if (latestContent) {
				lastNonEmptyContent = latestContent;
			}

			if (!toolCalls || toolCalls.length === 0) {
				return {ok: true, content: latestContent};
			}

			messages.push({
				role: 'assistant',
				content: responseMessage.content || '',
				tool_calls: responseMessage.tool_calls,
			});

			for (const tc of toolCalls) {
				const toolName = tc.function?.name;
				const tool = params.tools?.find(t => t.name === toolName);

				let args: Record<string, unknown> = {};
				const rawArgs = tc.function?.arguments;
				if (typeof rawArgs === 'string') {
					try {
						args = JSON.parse(rawArgs) as Record<string, unknown>;
					} catch (e) {
						console.error(`Synapse: failed to parse arguments for tool ${toolName}:`, e);
					}
				} else if (typeof rawArgs === 'object' && rawArgs !== null) {
					args = rawArgs;
				}

				let result: string;
				if (tool) {
					if (!params.app) {
						result = `Error: Obsidian App instance is not provided to execute tool "${toolName}".`;
					} else {
						const toolUseID = tc.id || `${toolName ?? tool.name}-${turn}`;
						let approved = true;
						let denyMessage: string | undefined;
						if (params.onApproveTool) {
							try {
								const approval = await params.onApproveTool(tool.name, args, {
									toolUseID,
									endpoint: baseUrl,
									isRemoteEndpoint: !isLoopbackEndpoint(baseUrl),
								});
								approved = approval.allow;
								denyMessage = approval.message;
							} catch (e) {
								// Fail closed — an approval handler that throws is treated as a
								// denial, not silently allowed.
								approved = false;
								denyMessage = e instanceof Error ? e.message : String(e);
							}
						}
						if (!approved) {
							result = `Tool "${toolName}" was not approved${denyMessage ? `: ${denyMessage}` : '.'}`;
						} else {
							try {
								result = await tool.execute(args, params.app);
							} catch (e) {
								result = `Error executing tool "${toolName}": ${e instanceof Error ? e.message : String(e)}`;
							}
						}
					}
				} else {
					result = `Error: Tool "${toolName}" is not available.`;
				}

				messages.push({
					role: 'tool',
					tool_call_id: tc.id || '',
					name: toolName,
					content: result,
				});
			}

			turn++;
		}

		// maxTurns exhausted without a final no-tool-call response: surface that the
		// content is truncated, falling back to the last non-empty assistant content
		// if the final turn was tool-calls-only.
		return {ok: true, content: latestContent || lastNonEmptyContent, truncated: true};
	} catch (e) {
		return {ok: false, error: `Local query failed: ${String(e)}`};
	}
}

