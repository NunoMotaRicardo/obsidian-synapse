/**
 * Friendly error formatting for failed native Write/Edit/NotebookEdit tool calls.
 *
 * The Agent SDK's Write/Edit/NotebookEdit tools are executed natively by the `claude` CLI
 * subprocess — the plugin has no custom tool implementation and can't intercept or retry a
 * failed call itself (that's handled by system-prompt guidance, see
 * `buildWriteRetryGuidance()` in `view/sessionConfig.ts`). This module only improves how a
 * failed write/edit is *displayed* to the user, mirroring the pattern the pre-BYOK-cleanup
 * `ollamaErrors.ts` used for Ollama connection errors: pattern-match common failure signatures
 * and return actionable guidance instead of a raw error string.
 */

/** Native SDK tool names that write to disk. */
const WRITE_TOOL_NAMES = new Set(['Write', 'Edit', 'NotebookEdit']);

export function isWriteToolName(toolName: string | undefined): boolean {
	return !!toolName && WRITE_TOOL_NAMES.has(toolName);
}

/**
 * True when a raw error message looks like a transient filesystem lock/permission issue
 * (e.g. a file open in another program, or mid-sync in OneDrive/Dropbox/iCloud) rather than
 * a logical error (bad path, invalid diff, etc.).
 */
export function isTransientWriteError(rawError: string): boolean {
	return /\bEBUSY\b|\bEPERM\b|\bEACCES\b|\bENOENT\b|resource busy or locked|being used by another process|permission denied|locked/i.test(rawError);
}

/**
 * Format a failed Write/Edit/NotebookEdit tool error for display in chat. Returns undefined
 * for non-write tools or errors that don't look transient/actionable — callers fall back to
 * the existing raw error display (e.g. the collapsed tool-call block).
 */
export function friendlyWriteToolError(toolName: string | undefined, rawError: string): string | undefined {
	if (!isWriteToolName(toolName) || !isTransientWriteError(rawError)) return undefined;
	return `${toolName} failed — the file may be locked by sync (OneDrive/Dropbox/iCloud) or open in another program. ` +
		`Original error: ${rawError}\n\nTry closing the file elsewhere and asking the assistant to retry, or retry manually in a moment.`;
}
