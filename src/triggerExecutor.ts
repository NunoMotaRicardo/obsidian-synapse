/**
 * Trigger executor — runs matched triggers against the configured model,
 * applies write modes, and records output.
 *
 * Called by TriggerWatcher (event triggers) and the cron runner (scheduled
 * triggers, issue #50).
 *
 * A thin caller over the shared pipeline in `runExecutor.ts` (issue #154):
 * this module supplies what's trigger-specific — the trigger's own report
 * identity/format, its `write` mode, its optional local-model/agent
 * routing, and the `triggerLastFired` stamp — and lets `runExecutor.ts` own
 * substitute → route → run → apply write mode → append report.
 *
 * No budget/turn-cap enforcement here — see the "Budget" note in
 * `.docs/specs/run-executor.md` for why triggers deliberately stay exempt.
 */

import type SynapsePlugin from './main';
import type {TriggerConfig} from './types';
import {REPORTS_FOLDER, todayString} from './vaultPaths';
import {normalizePath} from 'obsidian';
import {runItem, appendReportBlock, type ReportTarget} from './runExecutor';
import {LockAcquisitionError} from './lockManager';
import {debugTrace} from './debug';

// ---------------------------------------------------------------------------
// Report identity + graceful lock-timeout degrade
// ---------------------------------------------------------------------------

/** This trigger's report target for today: `_synapse/reports/<name>-YYYY-MM-DD.md`. */
function reportTargetFor(trigger: TriggerConfig): ReportTarget {
	const today = todayString();
	return {
		path: normalizePath(`${REPORTS_FOLDER}/${trigger.name}-${today}.md`),
		heading: `# ${trigger.name} — ${today}`,
	};
}

/**
 * Append a result block to the trigger's daily report file.
 *
 * If the report lock times out (a wedged holder), this degrades gracefully
 * — logs a warning and returns without throwing, rather than blocking
 * `executeTrigger` forever.
 */
async function appendToReport(
	plugin: SynapsePlugin,
	trigger: TriggerConfig,
	result: string,
	isError = false,
): Promise<void> {
	const block = isError ? `## Error\n\n${result}` : result;
	try {
		await appendReportBlock(plugin.app, reportTargetFor(trigger), block);
	} catch (e) {
		if (e instanceof LockAcquisitionError) {
			console.warn(`[synapse] Trigger "${trigger.name}": could not acquire report lock, dropping this report entry:`, e.message);
			return;
		}
		throw e;
	}
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Execute a matched trigger.
 *
 * Orchestrates template substitution, model routing, write-mode application,
 * and records the `triggerLastFired` timestamp.
 *
 * Errors are caught internally, logged to console, and appended to the
 * report file so failures are visible in the vault.
 */
export async function executeTrigger(
	plugin: SynapsePlugin,
	trigger: TriggerConfig,
	filePath: string,
): Promise<void> {
	try {
		await runItem({
			plugin,
			filePath,
			body: trigger.body,
			aliasFiles: true,
			model: trigger.model,
			agent: trigger.agent,
			write: trigger.write,
			logLabel: `Trigger "${trigger.name}"`,
			appendReport: (result, isError) => appendToReport(plugin, trigger, result, isError),
			surface: 'trigger',
			toolApprovalOverrideAllow: trigger.toolApproval === 'allow',
		});

		debugTrace(`[synapse] Trigger "${trigger.name}" executed successfully for ${filePath}`);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(`[synapse] Trigger "${trigger.name}" execution failed:`, e);

		// Append error to report so it's visible in the vault
		try {
			await appendToReport(plugin, trigger, msg, true);
		} catch (reportErr) {
			console.error('[synapse] Failed to write error report:', reportErr);
		}
	} finally {
		// Record last-fired timestamp regardless of success/failure
		plugin.settings.triggerLastFired[trigger.name] = Date.now();
		await plugin.saveSettings();
	}
}
