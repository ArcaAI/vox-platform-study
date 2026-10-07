/** TASK-1050 W2d — a guardrail hold is AWAITING_REVIEW but its note was blocked or withheld: never "ready". */

import { describe, expect, it } from 'vitest';
import { GUARDRAIL_HOLD_PROCESSING_REASONS, isGuardrailHoldReason, isNoteReady } from '../index';

describe('isNoteReady with a guardrail hold', () => {
  it('is false while processingReason is a hold reason, even if STOPPED + AWAITING_REVIEW', () => {
    for (const reason of GUARDRAIL_HOLD_PROCESSING_REASONS) {
      expect(isNoteReady({ status: 'STOPPED', processing: 'AWAITING_REVIEW', processingReason: reason }), reason).toBe(false);
    }
  });

  it('is unchanged for a human-review AWAITING_REVIEW and for NOTE_READY', () => {
    expect(isNoteReady({ status: 'STOPPED', processing: 'AWAITING_REVIEW' })).toBe(true);
    expect(isNoteReady({ status: 'STOPPED', processing: 'AWAITING_REVIEW', processingReason: 'COVERAGE_GAPS' })).toBe(true);
    expect(isNoteReady({ status: 'STOPPED', processing: 'IDLE', processingReason: 'NOTE_READY' })).toBe(true);
  });

  it('isGuardrailHoldReason names exactly the two hold reasons', () => {
    expect([...GUARDRAIL_HOLD_PROCESSING_REASONS]).toEqual(['GUARDRAIL_HOLD', 'EGRESS_REDACTION_UNAVAILABLE']);
    expect(isGuardrailHoldReason('GUARDRAIL_HOLD')).toBe(true);
    expect(isGuardrailHoldReason('NOTE_READY')).toBe(false);
    expect(isGuardrailHoldReason(null)).toBe(false);
    expect(isGuardrailHoldReason(undefined)).toBe(false);
  });
});
