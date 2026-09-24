import {describe, it, expect} from 'vitest';
import {AgentService} from '../src/agentService';
import type {Options} from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// AgentService#routeQueryOptions — plugin delivery gate (issue #265)
//
// SDK 0.3.281 adds `pluginDelivery: 'initialize'`, which sends `plugins` over
// stdin (`--await-initialize`) instead of one `--plugin-dir` argv flag per
// plugin — avoiding Windows' 32,767-character command-line limit. An older
// CLI (< 2.1.261) exits at startup with an unknown-option error when given
// the option at all, so `routeQueryOptions()` (the single choke point every
// real SDK query passes through) only sets it when the resolved CLI is known
// to meet that bar, and only when the call actually carries `plugins`.
// ---------------------------------------------------------------------------

type ResolvedCliPathLike = {path: string; source: string; version?: string};

function makeServiceWithCliVersion(version: string | undefined): AgentService {
	const service = new AgentService();
	if (version !== undefined) {
		(service as unknown as {resolvedCli: ResolvedCliPathLike}).resolvedCli = {path: '/fake/claude', source: 'settings', version};
	}
	return service;
}

function route(service: AgentService, options: Options): Options {
	return (service as unknown as {routeQueryOptions: (o: Options) => Options}).routeQueryOptions(options);
}

describe('AgentService#routeQueryOptions — pluginDelivery gate', () => {
	it('omits pluginDelivery on a CLI just below the threshold (2.1.260)', () => {
		const service = makeServiceWithCliVersion('2.1.260');
		const result = route(service, {plugins: [{type: 'local', path: '/vault/_synapse'}]});
		expect(result.pluginDelivery).toBeUndefined();
	});

	it('sets pluginDelivery to \'initialize\' at the threshold (2.1.261)', () => {
		const service = makeServiceWithCliVersion('2.1.261');
		const result = route(service, {plugins: [{type: 'local', path: '/vault/_synapse'}]});
		expect(result.pluginDelivery).toBe('initialize');
	});

	it('sets pluginDelivery to \'initialize\' above the threshold', () => {
		const service = makeServiceWithCliVersion('2.1.281');
		const result = route(service, {plugins: [{type: 'local', path: '/vault/_synapse'}]});
		expect(result.pluginDelivery).toBe('initialize');
	});

	it('omits pluginDelivery when the CLI version is unknown (not yet resolved)', () => {
		const service = makeServiceWithCliVersion(undefined);
		const result = route(service, {plugins: [{type: 'local', path: '/vault/_synapse'}]});
		expect(result.pluginDelivery).toBeUndefined();
	});

	it('omits pluginDelivery when there are no plugins, even on a qualifying CLI', () => {
		const service = makeServiceWithCliVersion('2.1.281');
		expect(route(service, {}).pluginDelivery).toBeUndefined();
		expect(route(service, {plugins: []}).pluginDelivery).toBeUndefined();
	});
});
