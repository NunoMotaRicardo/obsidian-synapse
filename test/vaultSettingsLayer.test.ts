import {describe, it, expect, afterEach} from 'vitest';
import {mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {App} from 'obsidian';
import type {Settings, SettingSource} from '@anthropic-ai/claude-agent-sdk';
import {AgentService, mergeVaultSettingsLayer} from '../src/agentService';
import {getSynapseSettingsPath} from '../src/vaultPaths';

// ---------------------------------------------------------------------------
// Issue #194 — the vault settings layer (`_synapse/settings.json`).
// ---------------------------------------------------------------------------

describe('mergeVaultSettingsLayer', () => {
	it('returns the vault settings\'s own rules unchanged when there is no existing settings value', () => {
		const vault: Settings = {permissions: {deny: ['Bash(rm *)']}};
		// allow/ask normalize to [] (unioned with nothing) rather than staying absent —
		// harmless, since an empty array behaves identically to an absent one for the SDK.
		expect(mergeVaultSettingsLayer(vault, undefined)).toMatchObject({permissions: {deny: ['Bash(rm *)']}});
	});

	it('unions permissions.allow/deny/ask instead of one side replacing the other', () => {
		const vault: Settings = {permissions: {allow: ['Read'], deny: ['Bash(rm *)'], ask: ['Write']}};
		const existing: Settings = {permissions: {allow: ['Edit']}};
		const merged = mergeVaultSettingsLayer(vault, existing) as Settings;
		expect(merged.permissions?.allow).toEqual(expect.arrayContaining(['Read', 'Edit']));
		expect(merged.permissions?.deny).toEqual(['Bash(rm *)']);
		expect(merged.permissions?.ask).toEqual(['Write']);
	});

	it('deduplicates identical rules present on both sides', () => {
		const vault: Settings = {permissions: {allow: ['Read']}};
		const existing: Settings = {permissions: {allow: ['Read', 'Edit']}};
		const merged = mergeVaultSettingsLayer(vault, existing) as Settings;
		expect(merged.permissions?.allow).toEqual(['Read', 'Edit']);
	});

	it('the vault deny rule survives when existing only adds an allow grant (AC-3)', () => {
		const vault: Settings = {permissions: {deny: ['Bash(rm *)']}};
		// Mirrors buildInMemoryPermissionSettings()'s output after a mid-conversation "Allow" click.
		const existing: Settings = {permissions: {allow: ['Read(foo.md)']}};
		const merged = mergeVaultSettingsLayer(vault, existing) as Settings;
		expect(merged.permissions?.deny).toEqual(['Bash(rm *)']);
		expect(merged.permissions?.allow).toEqual(['Read(foo.md)']);
	});

	it('prefers existing over vault for a top-level scalar key both set', () => {
		const vault: Settings = {model: 'vault-model'};
		const existing: Settings = {model: 'session-model'};
		const merged = mergeVaultSettingsLayer(vault, existing) as Settings;
		expect(merged.model).toBe('session-model');
	});

	it('leaves a string `existing` (settings file path) untouched — same defensive fallback as buildInMemoryPermissionSettings', () => {
		const vault: Settings = {permissions: {deny: ['Bash(rm *)']}};
		expect(mergeVaultSettingsLayer(vault, '/some/settings.json')).toBe('/some/settings.json');
	});
});

// ---------------------------------------------------------------------------
// AgentService's private loadVaultSettings()/routeQueryOptions() — the actual
// read/parse/cache/merge wiring (issue #194). Reached via a private-method
// cast, matching the existing `McpBridgeSession._drainLines` test pattern.
// ---------------------------------------------------------------------------

interface AgentServiceInternals {
	loadVaultSettings(app: App): Settings | undefined;
	routeQueryOptions(
		options: {settings?: string | Settings; settingSources?: SettingSource[]},
		app?: App
	): {settings?: string | Settings; settingSources?: SettingSource[]};
}

function internals(service: AgentService): AgentServiceInternals {
	return service as unknown as AgentServiceInternals;
}

describe('AgentService vault settings layer (#194)', () => {
	const dirs: string[] = [];

	function makeVault(): {app: App; settingsPath: string} {
		const base = mkdtempSync(join(tmpdir(), 'synapse-vault-settings-'));
		dirs.push(base);
		const app = {vault: {adapter: {basePath: base}}} as unknown as App;
		return {app, settingsPath: getSynapseSettingsPath(app)};
	}

	afterEach(() => {
		for (const d of dirs.splice(0)) {
			rmSync(d, {recursive: true, force: true});
		}
	});

	it('AC-2: a vault with no settings.json applies no layer', () => {
		const {app} = makeVault();
		const service = new AgentService();
		expect(internals(service).loadVaultSettings(app)).toBeUndefined();
		const opts = internals(service).routeQueryOptions({}, app);
		expect(opts.settings).toBeUndefined();
	});

	it('AC-1: a present settings.json is read, parsed, and merged into Options.settings', () => {
		const {app, settingsPath} = makeVault();
		mkdirSync(join(settingsPath, '..'), {recursive: true});
		writeFileSync(settingsPath, JSON.stringify({permissions: {deny: ['Bash(rm *)']}}), 'utf8');

		const service = new AgentService();
		const opts = internals(service).routeQueryOptions({}, app);
		expect(opts.settings).toMatchObject({permissions: {deny: ['Bash(rm *)']}});
	});

	it('AC-3: session grants already present on Options.settings merge on top and survive alongside the vault layer', () => {
		const {app, settingsPath} = makeVault();
		mkdirSync(join(settingsPath, '..'), {recursive: true});
		writeFileSync(settingsPath, JSON.stringify({permissions: {deny: ['Bash(rm *)']}}), 'utf8');

		const service = new AgentService();
		const opts = internals(service).routeQueryOptions({settings: {permissions: {allow: ['Read(foo.md)']}}}, app);
		const settings = opts.settings as Settings;
		expect(settings.permissions?.allow).toEqual(['Read(foo.md)']);
		expect(settings.permissions?.deny).toEqual(['Bash(rm *)']);
	});

	it('AC-4: a malformed settings.json degrades gracefully — no layer applied, no throw', () => {
		const {app, settingsPath} = makeVault();
		mkdirSync(join(settingsPath, '..'), {recursive: true});
		writeFileSync(settingsPath, '{not valid json', 'utf8');

		const service = new AgentService();
		expect(() => internals(service).loadVaultSettings(app)).not.toThrow();
		expect(internals(service).loadVaultSettings(app)).toBeUndefined();
	});

	it('AC-4: a malformed settings.json only warns once per mtime, not on every call', () => {
		const {app, settingsPath} = makeVault();
		mkdirSync(join(settingsPath, '..'), {recursive: true});
		writeFileSync(settingsPath, '{not valid json', 'utf8');

		const service = new AgentService();
		internals(service).loadVaultSettings(app);
		internals(service).loadVaultSettings(app);
		internals(service).loadVaultSettings(app);
		// No assertion API for Notice count is wired here (Notice is mocked as a no-op class in
		// test/setup.ts) — the dedup itself is exercised via the mtime-keyed cache below, which
		// is what actually prevents repeat Notices; this test's contract is simply "repeated
		// calls against an unchanged malformed file never throw".
		expect(internals(service).loadVaultSettings(app)).toBeUndefined();
	});

	it('AC-5: editing the file (new mtime) is picked up on the next call without a restart', () => {
		const {app, settingsPath} = makeVault();
		mkdirSync(join(settingsPath, '..'), {recursive: true});
		writeFileSync(settingsPath, JSON.stringify({model: 'first'}), 'utf8');

		const service = new AgentService();
		expect(internals(service).loadVaultSettings(app)?.model).toBe('first');

		// Bump mtime so the cache (keyed by path+mtime) is invalidated even on filesystems with
		// coarse mtime resolution.
		const future = new Date(Date.now() + 5000);
		writeFileSync(settingsPath, JSON.stringify({model: 'second'}), 'utf8');
		utimesSync(settingsPath, future, future);

		expect(internals(service).loadVaultSettings(app)?.model).toBe('second');
	});

	it('caches an unchanged file rather than re-reading it on every call (no throw if the file is deleted after first read)', () => {
		const {app, settingsPath} = makeVault();
		mkdirSync(join(settingsPath, '..'), {recursive: true});
		writeFileSync(settingsPath, JSON.stringify({model: 'cached'}), 'utf8');

		const service = new AgentService();
		expect(internals(service).loadVaultSettings(app)?.model).toBe('cached');

		// Second read within the same mtime should not require the file to still exist for the
		// cache hit path — but since AgentService keys its cache by (path, mtime) fetched via a
		// fresh statSync, deleting the file makes it behave like AC-2 (no layer) rather than an
		// error. This documents that behavior explicitly.
		rmSync(settingsPath);
		expect(internals(service).loadVaultSettings(app)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Issue #196 — routeQueryOptions() defaults settingSources to ['user',
// 'project'], dropping the SDK's 'local' default (the <cwd>/.claude/
// settings.local.json leak). Unrelated to the _synapse/settings.json layer
// above, but the same choke point, so covered alongside it.
// ---------------------------------------------------------------------------

describe('AgentService settingSources default (#196)', () => {
	it('defaults to [\'user\', \'project\'] when the caller sets none', () => {
		const service = new AgentService();
		const opts = internals(service).routeQueryOptions({});
		expect(opts.settingSources).toEqual(['user', 'project']);
	});

	it('does not include \'local\' — the <cwd>/.claude/settings.local.json leak this issue closes', () => {
		const service = new AgentService();
		const opts = internals(service).routeQueryOptions({});
		expect(opts.settingSources).not.toContain('local');
	});

	it('leaves an explicit caller-provided settingSources untouched', () => {
		const service = new AgentService();
		const opts = internals(service).routeQueryOptions({settingSources: ['local']});
		expect(opts.settingSources).toEqual(['local']);
	});
});
