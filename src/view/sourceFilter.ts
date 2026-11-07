// Per-conversation extension source toggles. Pure helpers (no Obsidian/SDK runtime imports) so they
// can be unit-tested: derive the list of toggleable sources from a `getContextUsage()` snapshot,
// then turn the user's disabled set into SDK option fragments.
import type {LocalPluginConfig} from '../vaultPaths';

export type SourceGroup = 'skills' | 'plugins' | 'mcp';

export interface SourceEntry {
	/** Stable id persisted per conversation, e.g. `skills:user`, `plugin:stocks@mkt`, `mcp:fanalytics`. */
	key: string;
	label: string;
	group: SourceGroup;
	/** Estimated tokens this source costs the context window (skills + agents + MCP tools). */
	tokens: number;
	/** `skills` group: unqualified skill names the source contributes. */
	skillNames: string[];
	/** `plugins` group: the plugin id (`name@marketplace`) or bare name for inline plugins. */
	pluginId?: string;
	/** `mcp` group: server name as reported by the CLI (normalized). */
	serverName?: string;
}

/** The subset of `SDKControlGetContextUsageResponse` this module reads. */
export interface ContextUsageLike {
	mcpTools?: {name: string; serverName: string; tokens: number}[];
	agents?: {agentType: string; source: string; pluginId?: string; tokens: number}[];
	skills?: {
		skillFrontmatter: {name: string; source: string; pluginName?: string; pluginId?: string; tokens: number}[];
	};
}

const SKILL_SOURCE_LABELS: Record<string, string> = {
	userSettings: 'User skills',
	projectSettings: 'Project skills',
};

/** `plugin:name` → `name`, `name@marketplace` → `name`. */
function pluginDisplayName(pluginId: string): string {
	return pluginId.split('@')[0] ?? pluginId;
}

function unqualified(name: string): string {
	const i = name.indexOf(':');
	return i >= 0 ? name.slice(i + 1) : name;
}

/** Group a context-usage snapshot into toggleable sources, grouped then sorted by token cost. */
export function buildSourceInventory(usage: ContextUsageLike | undefined): SourceEntry[] {
	if (!usage) return [];
	const entries = new Map<string, SourceEntry>();
	const touch = (key: string, init: Omit<SourceEntry, 'key' | 'tokens' | 'skillNames'>): SourceEntry => {
		let e = entries.get(key);
		if (!e) {
			e = {key, tokens: 0, skillNames: [], ...init};
			entries.set(key, e);
		}
		return e;
	};

	for (const s of usage.skills?.skillFrontmatter ?? []) {
		if (s.source === 'plugin' || s.pluginId || s.pluginName) {
			const id = s.pluginId ?? s.pluginName;
			if (!id) continue;
			const e = touch(`plugin:${id}`, {label: pluginDisplayName(id), group: 'plugins', pluginId: id});
			e.tokens += s.tokens;
			e.skillNames.push(unqualified(s.name));
		} else {
			const e = touch(`skills:${s.source}`, {label: SKILL_SOURCE_LABELS[s.source] ?? `Skills (${s.source})`, group: 'skills'});
			e.tokens += s.tokens;
			e.skillNames.push(unqualified(s.name));
		}
	}
	for (const a of usage.agents ?? []) {
		if (a.source !== 'plugin') continue;
		const id = a.pluginId ?? (a.agentType.includes(':') ? a.agentType.split(':')[0] : undefined);
		if (!id) continue;
		touch(`plugin:${id}`, {label: pluginDisplayName(id), group: 'plugins', pluginId: id}).tokens += a.tokens;
	}
	for (const t of usage.mcpTools ?? []) {
		touch(`mcp:${t.serverName}`, {label: t.serverName, group: 'mcp', serverName: t.serverName}).tokens += t.tokens;
	}

	const order: Record<SourceGroup, number> = {skills: 0, plugins: 1, mcp: 2};
	return [...entries.values()].sort((a, b) => order[a.group] - order[b.group] || b.tokens - a.tokens || a.label.localeCompare(b.label));
}

export interface SourceFilterInput {
	disabled: ReadonlySet<string>;
	inventory: readonly SourceEntry[];
	/** Skill names currently allowed by the selected agent. */
	enabledSkills: readonly string[];
	/** Local (inline) plugins the session would load. */
	plugins: readonly LocalPluginConfig[];
}

export interface SourceFilterResult {
	skills: string[];
	plugins: LocalPluginConfig[];
	disallowedTools: string[];
	/** `Options.settings.enabledPlugins` fragment; empty when no marketplace plugin is disabled. */
	enabledPlugins: Record<string, false>;
}

function localPluginName(p: LocalPluginConfig): string {
	const parts = p.path.replace(/\\/g, '/').split('/').filter(Boolean);
	return parts[parts.length - 1] ?? p.path;
}

/**
 * Translate the disabled-source set into SDK option fragments. A disabled key not present in
 * `inventory` is still honoured for plugins and MCP servers (their ids are in the key itself);
 * skill sources need the inventory to know which skill names to drop.
 */
export function buildSourceFilter(input: SourceFilterInput): SourceFilterResult {
	const {disabled, inventory} = input;
	const droppedSkills = new Set<string>();
	const disabledPluginIds: string[] = [];
	const disallowedTools: string[] = [];

	for (const key of disabled) {
		if (key.startsWith('plugin:')) disabledPluginIds.push(key.slice('plugin:'.length));
		else if (key.startsWith('mcp:')) disallowedTools.push(`mcp__${key.slice('mcp:'.length)}`);
		else if (key.startsWith('skills:')) {
			for (const e of inventory) if (e.key === key) for (const n of e.skillNames) droppedSkills.add(n);
		}
	}

	const localNames = new Set(input.plugins.map(localPluginName));
	const dropLocal = new Set(disabledPluginIds.map(pluginDisplayName).filter(n => localNames.has(n)));
	const enabledPlugins: Record<string, false> = {};
	for (const id of disabledPluginIds) {
		// An inline (vault) plugin is switched off by dropping it from `plugins`; only marketplace ids go to settings.
		const isInline = !id.includes('@') || id.endsWith('@inline');
		if (!(isInline && dropLocal.has(pluginDisplayName(id)))) enabledPlugins[id] = false;
	}

	return {
		skills: input.enabledSkills.filter(n => !droppedSkills.has(n)),
		plugins: input.plugins.filter(p => !dropLocal.has(localPluginName(p))),
		disallowedTools,
		enabledPlugins,
	};
}

/** Short summary for the toolbar button (`''` when everything is on). */
export function summarizeDisabled(disabled: ReadonlySet<string>): string {
	return disabled.size === 0 ? '' : `${disabled.size} off`;
}
