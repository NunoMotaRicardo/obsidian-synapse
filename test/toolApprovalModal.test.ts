import {describe, it, expect} from 'vitest';
import {resolveToolApprovalPresentation} from '../src/modals/toolApprovalModal';

// ---------------------------------------------------------------------------
// resolveToolApprovalPresentation — the pure hint->presentation mapping for
// ToolApprovalModal (issue #268). Covers the three ACs: suppressAlwaysAllowRule
// hides the permanent-rule affordance and stops Allow from widening beyond the
// single call, defaultToNo moves initial focus/default-styling to Deny, and
// with neither hint the modal behaves exactly as it did before (#193/#197).
// ---------------------------------------------------------------------------

describe('resolveToolApprovalPresentation', () => {
	it('with no hints: shows Always allow, Allow attaches updatedPermissions, Allow is the default CTA and gets focus (AC-3)', () => {
		const presentation = resolveToolApprovalPresentation({});

		expect(presentation).toEqual({
			showAlwaysAllow: true,
			suppressedNote: undefined,
			allowUpdatedPermissions: true,
			focusButton: 'allow',
			allowIsDefaultCta: true,
		});
	});

	it('suppressAlwaysAllowRule: hides Always allow and its rule preview, and Allow does not attach updatedPermissions (AC-1)', () => {
		const presentation = resolveToolApprovalPresentation({suppressAlwaysAllowRule: true});

		expect(presentation.showAlwaysAllow).toBe(false);
		expect(presentation.allowUpdatedPermissions).toBe(false);
		expect(presentation.suppressedNote).toBeTruthy();
	});

	it('suppressAlwaysAllowRule alone leaves focus/CTA styling untouched (independent of defaultToNo)', () => {
		const presentation = resolveToolApprovalPresentation({suppressAlwaysAllowRule: true});

		expect(presentation.focusButton).toBe('allow');
		expect(presentation.allowIsDefaultCta).toBe(true);
	});

	it('defaultToNo: focuses Deny and Allow is not the default CTA (AC-2)', () => {
		const presentation = resolveToolApprovalPresentation({defaultToNo: true});

		expect(presentation.focusButton).toBe('deny');
		expect(presentation.allowIsDefaultCta).toBe(false);
	});

	it('defaultToNo alone leaves Always allow untouched (independent of suppressAlwaysAllowRule)', () => {
		const presentation = resolveToolApprovalPresentation({defaultToNo: true});

		expect(presentation.showAlwaysAllow).toBe(true);
		expect(presentation.allowUpdatedPermissions).toBe(true);
	});

	it('both hints set: combines both effects', () => {
		const presentation = resolveToolApprovalPresentation({defaultToNo: true, suppressAlwaysAllowRule: true});

		expect(presentation).toEqual({
			showAlwaysAllow: false,
			suppressedNote: "Claude Code doesn't allow a permanent rule for this action.",
			allowUpdatedPermissions: false,
			focusButton: 'deny',
			allowIsDefaultCta: false,
		});
	});

	it('treats explicit false the same as undefined for both hints', () => {
		const explicitFalse = resolveToolApprovalPresentation({defaultToNo: false, suppressAlwaysAllowRule: false});
		const omitted = resolveToolApprovalPresentation({});

		expect(explicitFalse).toEqual(omitted);
	});
});
