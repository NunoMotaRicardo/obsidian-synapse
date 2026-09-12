/**
 * Permission/settings helpers for the Agent SDK (extracted from `agentService.ts` —
 * audit §1, issue #236).
 *
 * Part of the single SDK service surface documented in `specs/agent-service.md`. SDK types
 * are imported as `import type` only — erased at runtime, so no runtime SDK coupling leaves
 * `agentService.ts` (the architecture rule's purpose: no other file may *use* the SDK at
 * runtime; consumers keep importing these symbols through `agentService.ts`'s re-exports).
 */

import type {
	Options,
	PermissionUpdate,
	PermissionRuleValue,
	Settings,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Rewrite CLI-suggested permission updates so approving a tool call never persists a grant to
 * disk. The CLI's `canUseTool` suggestions carry a `destination` of `'userSettings'`,
 * `'projectSettings'`, `'localSettings'`, `'session'`, or `'cliArg'` — for directory-shaped
 * grants (e.g. an out-of-vault `Read` on an attached folder) it suggests `'localSettings'`,
 * which the SDK writes to `<cwd>/.claude/settings.local.json` inside the vault (issue #193).
 * Every `PermissionUpdate` union variant carries `destination`, so overwriting it via spread is
 * type-safe without a per-variant switch. Forcing `'session'` keeps the approval in effect for
 * the rest of the conversation (no re-prompt loop) without ever touching disk.
 */
export function sessionScopePermissions(suggestions: PermissionUpdate[]): PermissionUpdate[] {
	return suggestions.map(u => ({...u, destination: 'session'}));
}

/**
 * Convert one `PermissionRuleValue` to the CLI's rule-string syntax used in
 * `Settings.permissions.allow` entries: `toolName` alone, or `toolName(ruleContent)` when a
 * rule content (e.g. a path/pattern) is present — matching what the CLI itself writes to
 * `settings.local.json` for the same suggestion (issue #193 round 2).
 */
export function permissionRuleToString(rule: PermissionRuleValue): string {
	return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

/**
 * Extract allow-rule strings from a set of CLI-suggested `PermissionUpdate`s, for accumulating
 * into the in-memory grant set `sessionScopePermissions()`'s `'session'` destination can't
 * survive across a query() respawn (issue #193 round 2 — see "In-memory tool-approval grants" in
 * `specs/agent-service.md`).
 *
 * Only `addRules` updates with `behavior: 'allow'` translate into an allow-rule. Every other
 * update type this union carries — `replaceRules`/`removeRules` (there is no faithful way to
 * "replace" or "remove" against a purely additive in-memory accumulator), `setMode`, and
 * `addDirectories`/`removeDirectories` — is skipped rather than guessed at. A `behavior` other
 * than `'allow'` (i.e. `'deny'`/`'ask'`) is also skipped: the CLI does not suggest those for an
 * approved tool call, and this function only ever runs on suggestions attached to an `allow`
 * decision (see `ToolApprovalModal`'s Allow button / `SynapseView`'s auto-allow branch).
 */
export function extractAllowRuleStrings(suggestions: PermissionUpdate[]): string[] {
	const rules: string[] = [];
	for (const u of suggestions) {
		if (u.type === 'addRules' && u.behavior === 'allow') {
			rules.push(...u.rules.map(permissionRuleToString));
		}
	}
	return rules;
}

/**
 * Build the inline `Options.settings` value carrying the conversation's accumulated in-memory
 * tool-approval grants (issue #193 round 2), merged with any pre-existing `settings` a caller
 * already set rather than clobbering it.
 *
 * This is what makes an **ask**-mode approval survive the Agent SDK's per-`send()` respawn: the
 * CLI loads an inline `settings` object into its highest-priority user-controlled "flag
 * settings" layer on every `query()` call, so re-sending the same accumulated `allow` list on
 * every turn re-grants it without ever writing to disk — unlike `destination: 'session'`
 * (`sessionScopePermissions()`), which only covers the *current* CLI process and is lost the
 * moment the next `send()` spawns a fresh one.
 *
 * `existing` merges as an object (its own `permissions.allow` list is unioned with `grants`,
 * every other key preserved); if `existing` is a settings *file path* (the SDK also accepts
 * `settings: string`) it is left untouched and returned as-is — there is no way to fold an
 * in-memory grant list into a file on disk without writing to it, which this feature must never
 * do (issue #193's whole point). No caller in this codebase currently sets a string `settings`
 * path, so this is a defensive fallback, not an exercised path.
 */
export function buildInMemoryPermissionSettings(
	grants: Iterable<string>,
	existing?: Options['settings']
): Options['settings'] {
	const allow = Array.from(new Set(grants));
	if (allow.length === 0) return existing;
	if (typeof existing === 'string') return existing;
	return {
		...existing,
		permissions: {
			...existing?.permissions,
			allow: Array.from(new Set([...(existing?.permissions?.allow ?? []), ...allow])),
		},
	};
}

/**
 * Merge the vault's own settings layer (`_synapse/settings.json`, issue #194) beneath whatever
 * `Options.settings` a call site/session already carries — including, notably, #193's
 * in-memory tool-approval grants (`buildInMemoryPermissionSettings()`'s output, folded into
 * `Session.applyToolGrants()`'s `this.config.settings`).
 *
 * `vaultSettings` is always the base and `existing` is always layered on top: `permissions.allow`
 * /`deny`/`ask` are unioned (nothing from either side is dropped — the vault's own rules survive
 * a later `applyToolGrants()` call, AC-3), while every other top-level key prefers `existing`'s
 * value when both set it, so a caller's/session's explicit settings win on conflict.
 *
 * If `existing` is a settings *file path* rather than an object, it is returned unchanged — same
 * defensive convention as `buildInMemoryPermissionSettings()`'s `existing` handling, and for the
 * same reason: there is no way to fold an object (the parsed vault file) into an arbitrary path
 * on disk without writing to it. No caller in this codebase sets a string `Options.settings`
 * today.
 */
export function mergeVaultSettingsLayer(vaultSettings: Settings, existing?: Options['settings']): Options['settings'] {
	if (typeof existing === 'string') return existing;
	return {
		...vaultSettings,
		...existing,
		permissions: {
			...vaultSettings.permissions,
			...existing?.permissions,
			allow: Array.from(new Set([...(vaultSettings.permissions?.allow ?? []), ...(existing?.permissions?.allow ?? [])])),
			deny: Array.from(new Set([...(vaultSettings.permissions?.deny ?? []), ...(existing?.permissions?.deny ?? [])])),
			ask: Array.from(new Set([...(vaultSettings.permissions?.ask ?? []), ...(existing?.permissions?.ask ?? [])])),
		},
	};
}