/**
 * Ollama-specific error detection and user-friendly message mapping.
 * Only used when `providerPreset === 'ollama'`.
 */

/** Friendly message for tool-use failures. */
export const TOOL_USE_GUIDANCE = 'This model does not support tool use. Try a model that supports function calling, such as qwen2.5 or llama3.1.';

/** Friendly message for vision/image failures. */
export const VISION_GUIDANCE = 'This model does not support images. Try a multimodal model such as llava, llama3.2-vision, or gemma3.';

interface OllamaErrorMatch {
	/** Pattern to match against the raw error message (case-insensitive). */
	pattern: RegExp;
	/** Friendly message shown to the user. */
	friendly: string;
}

const OLLAMA_ERROR_PATTERNS: OllamaErrorMatch[] = [
	// Connection errors — Ollama not running
	{
		pattern: /econnrefused|connection refused/i,
		friendly: 'Could not connect to Ollama. Make sure Ollama is running (check the system tray or run "ollama serve").',
	},
	{
		pattern: /enotfound|getaddrinfo/i,
		friendly: 'Could not resolve the Ollama host. Check the base URL in **Settings → Models**.',
	},
	{
		pattern: /etimedout|timeout|timed out/i,
		friendly: 'Connection to Ollama timed out. Make sure Ollama is running and the base URL is correct.',
	},
	{
		pattern: /econnreset|socket hang up/i,
		friendly: 'Connection to Ollama was reset. The model may have crashed or run out of memory. Try a smaller model.',
	},
	// Model not found
	{
		pattern: /model.*not found|model.*does not exist|pull.*first/i,
		friendly: 'Model not found in Ollama. Pull it first with "ollama pull <model-name>" or choose a different model in **Settings → Models**.',
	},
	// Out of memory
	{
		pattern: /out of memory|oom|insufficient memory|not enough memory/i,
		friendly: 'Ollama ran out of memory. Try a smaller model (e.g. a quantized variant) or close other applications.',
	},
	// Tool use not supported
	{
		pattern: /does not support tools|tool.?use.*not.*support|tools.*not.*available|invalid.*tool|tool_calls.*not.*supported/i,
		friendly: TOOL_USE_GUIDANCE,
	},
	// Vision not supported
	{
		pattern: /does not support (vision|image|multimodal)|image.*not.*support|vision.*not.*available|invalid.*image|cannot process image|unexpected.*image/i,
		friendly: VISION_GUIDANCE,
	},
	// 404 / bad endpoint
	{
		pattern: /404|not found.*endpoint|path not found/i,
		friendly: 'Ollama endpoint not found (404). Check the base URL in **Settings → Models** — the default is http://localhost:11434/v1. Also ensure a model is selected.',
	},
	// Generic fetch failures
	{
		pattern: /fetch failed|network error|network request/i,
		friendly: 'Network error connecting to Ollama. Make sure Ollama is running and accessible.',
	},
];

/**
 * Given a raw error message, return a user-friendly Ollama-specific message,
 * or `null` if no pattern matches (in which case the caller shows the raw error).
 */
export function friendlyOllamaError(rawMessage: string): string | null {
	for (const {pattern, friendly} of OLLAMA_ERROR_PATTERNS) {
		if (pattern.test(rawMessage)) {
			return friendly;
		}
	}
	return null;
}

/**
 * Check if a tool execution error indicates the model doesn't support tool use.
 */
export function isToolUseError(errorMessage: string): boolean {
	return /does not support tools|tool.?use.*not.*support|tools.*not.*available|invalid.*tool|tool_calls.*not.*supported/i.test(errorMessage);
}

/**
 * Check if an error indicates the model doesn't support vision/images.
 */
export function isVisionError(errorMessage: string): boolean {
	return /does not support (vision|image|multimodal)|image.*not.*support|vision.*not.*available|invalid.*image|cannot process image|unexpected.*image/i.test(errorMessage);
}

/**
 * Format an error message for an Obsidian Notice, using Ollama-friendly messages when applicable.
 */
export function formatErrorForNotice(error: unknown, providerPreset: string): string {
	const rawError = String(error);
	const cleanError = rawError.startsWith('Error: ') ? rawError.slice(7) : rawError;
	if (providerPreset === 'ollama') {
		const friendly = friendlyOllamaError(cleanError);
		if (friendly) {
			return `Ollama: ${friendly}`;
		}
	}
	return `Sidekick: error — ${cleanError}`;
}
