/**
 * Shared budget/threshold primitives — a small, dependency-free module
 * powering the interactive chat view's turn/cost thresholds
 * (`synapseView.ts`, issue #88).
 *
 * Kept intentionally tiny: a type, a free-text parser, a describer, and an
 * "exceeded" predicate. Extracted here (rather than duplicated) so callers
 * wanting identical parsing/formatting behavior don't have to reimplement it —
 * see `specs/agent-service.md` / `specs/chat-view.md` for the decision note.
 */

/**
 * A user-configured spend cap — either a maximum total token count (input +
 * output + cache tokens, summed) or a maximum total dollar spend.
 * `undefined` (no budget set) means unlimited.
 */
export type Budget =
	| {type: 'tokens'; max: number}
	| {type: 'dollars'; max: number};

/**
 * Cumulative usage/cost tracked for budget enforcement.
 */
export interface BudgetUsage {
	totalTokens: number;
	totalCostUsd: number;
}

/**
 * Parse a free-text budget input into a `Budget`, or `undefined` for "no
 * budget" (empty input, or the literal `none`/`skip`).
 *
 * Accepted formats:
 * - `$5`, `$5.50`, `5 dollars`, `5 usd` → dollar budget.
 * - `500000`, `500000 tokens` → token budget (bare numbers default to tokens;
 *   must be a whole number — token usage is always integer, so a fractional
 *   value like `1.5` is almost certainly a typo and is rejected).
 * - `` (empty), `none`, `skip` → no budget (unlimited, case-insensitive).
 *
 * Returns `null` if the input doesn't parse as any of the above, so the
 * caller can re-prompt/reject rather than silently ignoring a typo.
 */
export function parseBudgetInput(raw: string): Budget | undefined | null {
	const trimmed = raw.trim();
	if (trimmed === '' || /^(none|skip)$/i.test(trimmed)) {
		return undefined;
	}

	const dollarMatch = trimmed.match(/^\$?\s*([0-9]+(?:\.[0-9]+)?)\s*(usd|dollars?|\$)?$/i);
	if (dollarMatch && (trimmed.startsWith('$') || /usd|dollars?|\$/i.test(dollarMatch[2] ?? ''))) {
		const max = Number(dollarMatch[1]);
		if (!Number.isFinite(max) || max <= 0) return null;
		return {type: 'dollars', max};
	}

	const tokenMatch = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*(tokens?)?$/i);
	if (tokenMatch) {
		const max = Number(tokenMatch[1]);
		if (!Number.isInteger(max) || max <= 0) return null;
		return {type: 'tokens', max};
	}

	return null;
}

/** Human-readable description of a budget, for `Notice`s and chat messages. */
export function describeBudget(budget: Budget): string {
	return budget.type === 'dollars'
		? `$${budget.max.toFixed(2)}`
		: `${budget.max.toLocaleString()} tokens`;
}

/** Whether cumulative usage has met or exceeded the configured budget. */
export function budgetExceeded(usage: BudgetUsage, budget: Budget): boolean {
	return budget.type === 'dollars' ? usage.totalCostUsd >= budget.max : usage.totalTokens >= budget.max;
}
