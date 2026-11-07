import {describe, it, expect} from 'vitest';
import {buildSourceInventory, buildSourceFilter, summarizeDisabled} from '../src/view/sourceFilter';
import {upsertSessionContext, resolveConversationContext} from '../src/view/sessionConfig';

const usage = {
	skills: {skillFrontmatter: [
		{name: 'omarchy', source: 'userSettings', tokens: 230},
		{name: 'diagnose-crash', source: 'userSettings', tokens: 160},
		{name: 'stocks:stocks-pm', source: 'plugin', pluginName: 'stocks', pluginId: 'stocks@mkt', tokens: 170},
		{name: '_synapse:think', source: 'plugin', pluginName: '_synapse', pluginId: '_synapse@inline', tokens: 150},
	]},
	agents: [{agentType: '_synapse:Writer', source: 'plugin', pluginId: '_synapse@inline', tokens: 118}],
	mcpTools: [
		{name: 'mcp__fanalytics__get_prices', serverName: 'fanalytics', tokens: 1700},
		{name: 'mcp__fanalytics__describe_data', serverName: 'fanalytics', tokens: 227},
	],
};
const localPlugins = [{type: 'local' as const, path: '/vault/_synapse/'}];

describe('buildSourceInventory', () => {
	it('groups skills, plugins and MCP servers with summed tokens', () => {
		const inv = buildSourceInventory(usage);
		expect(inv.map(e => e.key)).toEqual(['skills:userSettings', 'plugin:_synapse@inline', 'plugin:stocks@mkt', 'mcp:fanalytics']);
		expect(inv.find(e => e.key === 'plugin:_synapse@inline')?.tokens).toBe(268);
		expect(inv.find(e => e.key === 'mcp:fanalytics')?.tokens).toBe(1927);
	});
	it('is empty without a snapshot', () => {
		expect(buildSourceInventory(undefined)).toEqual([]);
	});
});

describe('buildSourceFilter', () => {
	const base = {inventory: buildSourceInventory(usage), enabledSkills: ['omarchy', 'diagnose-crash', 'think'], plugins: localPlugins};
	it('is a no-op with nothing disabled', () => {
		const r = buildSourceFilter({...base, disabled: new Set()});
		expect(r.skills).toEqual(base.enabledSkills);
		expect(r.plugins).toEqual(localPlugins);
		expect(r.disallowedTools).toEqual([]);
		expect(r.enabledPlugins).toEqual({});
	});
	it('drops user skills, local plugin, marketplace plugin and MCP server', () => {
		const r = buildSourceFilter({...base, disabled: new Set(['skills:userSettings', 'plugin:_synapse@inline', 'plugin:stocks@mkt', 'mcp:fanalytics'])});
		expect(r.skills).toEqual(['think']);
		expect(r.plugins).toEqual([]);
		expect(r.enabledPlugins).toEqual({'stocks@mkt': false});
		expect(r.disallowedTools).toEqual(['mcp__fanalytics']);
	});
});

describe('per-conversation persistence', () => {
	it('round-trips disabledSources and omits it when empty', () => {
		const ctx = {workingDir: '', notePath: null, scopePaths: [], disabledSources: ['mcp:fanalytics']};
		const map = upsertSessionContext(undefined, 's1', ctx);
		expect(resolveConversationContext(map.s1, undefined, '/v').disabledSources).toEqual(['mcp:fanalytics']);
		const empty = upsertSessionContext(undefined, 's2', {...ctx, disabledSources: []});
		expect('disabledSources' in empty.s2!).toBe(false);
	});
	it('summarizes the disabled count', () => {
		expect(summarizeDisabled(new Set())).toBe('');
		expect(summarizeDisabled(new Set(['a', 'b']))).toBe('2 off');
	});
});
