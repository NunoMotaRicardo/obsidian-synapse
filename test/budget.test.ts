import {describe, it, expect} from 'vitest';
import {parseBudgetInput, describeBudget, budgetExceeded} from '../src/budget';

// ---------------------------------------------------------------------------
// parseBudgetInput
// ---------------------------------------------------------------------------

describe('parseBudgetInput', () => {
	it('empty string means no budget', () => {
		expect(parseBudgetInput('')).toBeUndefined();
	});

	it('whitespace-only string means no budget', () => {
		expect(parseBudgetInput('   ')).toBeUndefined();
	});

	it('"none" (case-insensitive) means no budget', () => {
		expect(parseBudgetInput('none')).toBeUndefined();
		expect(parseBudgetInput('NONE')).toBeUndefined();
	});

	it('"skip" (case-insensitive) means no budget', () => {
		expect(parseBudgetInput('skip')).toBeUndefined();
		expect(parseBudgetInput('Skip')).toBeUndefined();
	});

	it('bare number parses as a token budget', () => {
		expect(parseBudgetInput('500000')).toEqual({type: 'tokens', max: 500000});
	});

	it('"N tokens" parses as a token budget', () => {
		expect(parseBudgetInput('500000 tokens')).toEqual({type: 'tokens', max: 500000});
	});

	it('"N token" (singular) parses as a token budget', () => {
		expect(parseBudgetInput('1 token')).toEqual({type: 'tokens', max: 1});
	});

	it('fractional token count is rejected (returns null)', () => {
		expect(parseBudgetInput('1.5')).toBeNull();
		expect(parseBudgetInput('1.5 tokens')).toBeNull();
	});

	it('zero or negative token count is rejected', () => {
		expect(parseBudgetInput('0')).toBeNull();
		expect(parseBudgetInput('-5')).toBeNull();
	});

	it('"$5" parses as a dollar budget', () => {
		expect(parseBudgetInput('$5')).toEqual({type: 'dollars', max: 5});
	});

	it('"$5.50" parses as a dollar budget', () => {
		expect(parseBudgetInput('$5.50')).toEqual({type: 'dollars', max: 5.5});
	});

	it('"5 dollars" parses as a dollar budget', () => {
		expect(parseBudgetInput('5 dollars')).toEqual({type: 'dollars', max: 5});
	});

	it('"5 dollar" (singular) parses as a dollar budget', () => {
		expect(parseBudgetInput('5 dollar')).toEqual({type: 'dollars', max: 5});
	});

	it('"5 usd" (case-insensitive) parses as a dollar budget', () => {
		expect(parseBudgetInput('5 usd')).toEqual({type: 'dollars', max: 5});
		expect(parseBudgetInput('5 USD')).toEqual({type: 'dollars', max: 5});
	});

	it('zero or negative dollar amount is rejected', () => {
		expect(parseBudgetInput('$0')).toBeNull();
		expect(parseBudgetInput('-$5')).toBeNull();
	});

	it('unparseable input returns null so the caller can re-prompt', () => {
		expect(parseBudgetInput('banana')).toBeNull();
		expect(parseBudgetInput('$$5')).toBeNull();
		expect(parseBudgetInput('five dollars')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// describeBudget
// ---------------------------------------------------------------------------

describe('describeBudget', () => {
	it('formats a token budget with locale-formatted thousands separators', () => {
		// Compare against toLocaleString() directly rather than a hardcoded
		// separator — the exact separator character is locale-dependent (the
		// test environment's default locale need not be en-US).
		expect(describeBudget({type: 'tokens', max: 500000})).toBe(`${(500000).toLocaleString()} tokens`);
	});

	it('formats a small token budget without separators', () => {
		expect(describeBudget({type: 'tokens', max: 1})).toBe('1 tokens');
	});

	it('formats a dollar budget with two decimal places', () => {
		expect(describeBudget({type: 'dollars', max: 5})).toBe('$5.00');
		expect(describeBudget({type: 'dollars', max: 5.5})).toBe('$5.50');
	});
});

// ---------------------------------------------------------------------------
// budgetExceeded
// ---------------------------------------------------------------------------

describe('budgetExceeded', () => {
	it('token budget: false when usage is below the max', () => {
		expect(budgetExceeded({totalTokens: 100, totalCostUsd: 0}, {type: 'tokens', max: 500})).toBe(false);
	});

	it('token budget: true when usage meets the max', () => {
		expect(budgetExceeded({totalTokens: 500, totalCostUsd: 0}, {type: 'tokens', max: 500})).toBe(true);
	});

	it('token budget: true when usage exceeds the max', () => {
		expect(budgetExceeded({totalTokens: 600, totalCostUsd: 0}, {type: 'tokens', max: 500})).toBe(true);
	});

	it('dollar budget: false when cost is below the max', () => {
		expect(budgetExceeded({totalTokens: 0, totalCostUsd: 1}, {type: 'dollars', max: 5})).toBe(false);
	});

	it('dollar budget: true when cost meets the max', () => {
		expect(budgetExceeded({totalTokens: 0, totalCostUsd: 5}, {type: 'dollars', max: 5})).toBe(true);
	});

	it('dollar budget checks totalCostUsd, not totalTokens', () => {
		expect(budgetExceeded({totalTokens: 999999, totalCostUsd: 0}, {type: 'dollars', max: 5})).toBe(false);
	});
});
