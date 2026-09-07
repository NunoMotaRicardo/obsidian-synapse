import {describe, it, expect} from 'vitest';
import {buildAskUserQuestionAnswers} from '../src/modals/askUserQuestionModal';
import type {AskUserQuestionQuestion} from '../src/modals/askUserQuestionModal';

// ---------------------------------------------------------------------------
// buildAskUserQuestionAnswers — the pure input->answers/annotations mapping
// (issue #182), pinned against facts verified live against the CLI: keyed by
// question text, valued by the selected option's label; multi-select joins
// labels with ", "; a free-text "Other" answer is the typed string as-is.
// ---------------------------------------------------------------------------

function question(overrides: Partial<AskUserQuestionQuestion> = {}): AskUserQuestionQuestion {
	return {
		question: 'Which library should we use for date formatting?',
		header: 'Library',
		multiSelect: false,
		options: [
			{label: 'date-fns', description: 'Lightweight, tree-shakeable'},
			{label: 'Luxon', description: 'Immutable, timezone-aware'},
		],
		...overrides,
	};
}

describe('buildAskUserQuestionAnswers', () => {
	it('single-select: answer is the selected option label', () => {
		const q = question();
		const states = new Map([[q.question, {selectedLabels: new Set(['Luxon']), otherSelected: false, otherText: ''}]]);

		const {answers} = buildAskUserQuestionAnswers([q], states);

		expect(answers).toEqual({[q.question]: 'Luxon'});
	});

	it('multi-select: answer joins selected labels with ", " in option order', () => {
		const q = question({
			question: 'Which features do you want to enable?',
			multiSelect: true,
			options: [
				{label: 'Alpha', description: 'a'},
				{label: 'Beta', description: 'b'},
				{label: 'Gamma', description: 'c'},
			],
		});
		const states = new Map([[q.question, {selectedLabels: new Set(['Gamma', 'Alpha']), otherSelected: false, otherText: ''}]]);

		const {answers} = buildAskUserQuestionAnswers([q], states);

		// Verified against the live CLI: "Alpha, Gamma" — option order, not selection order.
		expect(answers[q.question]).toBe('Alpha, Gamma');
	});

	it('"Other" answer is the typed free-text string as-is', () => {
		const q = question();
		const states = new Map([[q.question, {selectedLabels: new Set<string>(), otherSelected: true, otherText: 'day.js actually'}]]);

		const {answers} = buildAskUserQuestionAnswers([q], states);

		expect(answers).toEqual({[q.question]: 'day.js actually'});
	});

	it('an unanswered question is omitted from the answers map', () => {
		const q = question();
		const states = new Map([[q.question, {selectedLabels: new Set<string>(), otherSelected: false, otherText: ''}]]);

		const {answers} = buildAskUserQuestionAnswers([q], states);

		expect(answers).toEqual({});
	});

	it('multiple questions are each keyed by their own question text', () => {
		const q1 = question({question: 'Q1?'});
		const q2 = question({question: 'Q2?', options: [{label: 'X', description: 'x'}, {label: 'Y', description: 'y'}]});
		const states = new Map([
			[q1.question, {selectedLabels: new Set(['date-fns']), otherSelected: false, otherText: ''}],
			[q2.question, {selectedLabels: new Set(['Y']), otherSelected: false, otherText: ''}],
		]);

		const {answers} = buildAskUserQuestionAnswers([q1, q2], states);

		expect(answers).toEqual({'Q1?': 'date-fns', 'Q2?': 'Y'});
	});

	it('populates annotations.preview for a single-select answer whose option carries a preview', () => {
		const q = question({
			options: [
				{label: 'date-fns', description: 'Lightweight', preview: 'import {format} from "date-fns"'},
				{label: 'Luxon', description: 'Immutable'},
			],
		});
		const states = new Map([[q.question, {selectedLabels: new Set(['date-fns']), otherSelected: false, otherText: ''}]]);

		const {annotations} = buildAskUserQuestionAnswers([q], states);

		expect(annotations).toEqual({[q.question]: {preview: 'import {format} from "date-fns"'}});
	});

	it('omits annotations when the selected option has no preview', () => {
		const q = question();
		const states = new Map([[q.question, {selectedLabels: new Set(['Luxon']), otherSelected: false, otherText: ''}]]);

		const {annotations} = buildAskUserQuestionAnswers([q], states);

		expect(annotations).toEqual({});
	});

	it('omits annotations for a multi-select answer even if an option has a preview', () => {
		const q = question({
			multiSelect: true,
			options: [
				{label: 'date-fns', description: 'Lightweight', preview: 'preview text'},
				{label: 'Luxon', description: 'Immutable'},
			],
		});
		const states = new Map([[q.question, {selectedLabels: new Set(['date-fns', 'Luxon']), otherSelected: false, otherText: ''}]]);

		const {annotations} = buildAskUserQuestionAnswers([q], states);

		expect(annotations).toEqual({});
	});

	it('omits annotations for an "Other" answer', () => {
		const q = question({
			options: [
				{label: 'date-fns', description: 'Lightweight', preview: 'preview text'},
				{label: 'Luxon', description: 'Immutable'},
			],
		});
		const states = new Map([[q.question, {selectedLabels: new Set<string>(), otherSelected: true, otherText: 'something else'}]]);

		const {annotations} = buildAskUserQuestionAnswers([q], states);

		expect(annotations).toEqual({});
	});
});
