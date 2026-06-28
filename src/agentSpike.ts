/**
 * agent-spike — Proof-of-concept: stream a trivial chat turn from the Claude
 * Agent SDK (`@anthropic-ai/claude-agent-sdk`) inside Obsidian.
 *
 * This is a throwaway spike module — it does NOT go through CopilotService and
 * is not wired into the production chat panel. It exists only to validate that
 * the SDK installs, bundles, resolves the `claude` CLI, and streams tokens in
 * the Electron/Node environment.
 */

import {query} from '@anthropic-ai/claude-agent-sdk';
import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';

export interface SpikeResult {
	ok: boolean;
	/** Concatenated assistant text (when ok). */
	text?: string;
	/** Error message (when !ok). */
	error?: string;
	/** Raw message types received, for diagnostics. */
	messageTypes: string[];
	/** Duration in ms. */
	durationMs: number;
}

/**
 * Send a trivial prompt to Claude via the Agent SDK and collect streamed
 * tokens. Returns the concatenated response text or an error.
 */
export async function runAgentSpike(): Promise<SpikeResult> {
	const start = Date.now();
	const messageTypes: string[] = [];
	const textParts: string[] = [];

	try {
		const stream = query({
			prompt: 'Reply with exactly: "Hello from Claude Agent SDK inside Obsidian!" — nothing else.',
			options: {
				maxTurns: 1,
				systemPrompt: 'You are a concise assistant used for a connectivity test. Reply only with the exact text requested.',
				tools: [],
				permissionMode: 'plan',
			},
		});

		for await (const msg of stream) {
			const sdkMsg = msg as SDKMessage;
			messageTypes.push(sdkMsg.type);

			if (sdkMsg.type === 'assistant') {
				// Full assistant message — extract text content blocks
				const betaMsg = sdkMsg.message;
				for (const block of betaMsg.content) {
					if (block.type === 'text') {
						textParts.push(block.text);
					}
				}
			} else if (sdkMsg.type === 'stream_event') {
				// Partial streaming event — extract text deltas
				const event = sdkMsg.event;
				if (event.type === 'content_block_delta' && 'delta' in event && event.delta.type === 'text_delta') {
					textParts.push(event.delta.text);
				}
			}
		}

		const text = textParts.join('');
		return {
			ok: text.length > 0,
			text: text || '(no text received)',
			messageTypes,
			durationMs: Date.now() - start,
		};
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e.message : String(e),
			messageTypes,
			durationMs: Date.now() - start,
		};
	}
}
