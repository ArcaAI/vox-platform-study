/**
 * TASK-1050 W1 — the guardrail wire vocabulary is frozen by `tests/contracts/guardrail-vocabulary.fixture.json`,
 * and the check ids are pinned against the availability catalogue the Python plane reads too.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EGRESS_REDACTION_UNAVAILABLE_REASON,
  GUARDRAIL_HOLD_PROCESSING_REASONS,
  GUARDRAIL_HOLD_REASON,
  isGuardrailHoldReason,
  isNoteReady,
  NOTE_READY_REASON,
} from '../consultation-lifecycle.js';
import { GUARDRAIL_EVALUATION_BATCH_MAX, GUARDRAIL_EVALUATIONS_PATH } from '../guardrail-evaluation.js';
import {
  GUARDRAIL_ACKNOWLEDGEMENT_VIAS,
  GUARDRAIL_HOLD_RESOLUTIONS,
  GUARDRAIL_HOLD_RESUME_PATH,
  guardrailHoldResumePath,
} from '../guardrail-hold.js';
import {
  GUARDRAIL_BLOCKED_PROBLEM_TYPE,
  GUARDRAIL_NOTICE_ACTIONS,
  GUARDRAIL_NOTICE_DEFAULT_MESSAGES,
  GUARDRAIL_NOTICE_MESSAGE_KEYS,
  GUARDRAIL_NOTICE_SCHEMA_VERSION,
  GUARDRAIL_NOTICE_SEVERITIES,
  GUARDRAIL_NOTICE_TYPE_ACTION,
  GUARDRAIL_NOTICE_TYPES,
  guardrailNoticeDefaultMessage,
  type GuardrailNotice,
} from '../guardrail-notice.js';
import {
  GUARDRAIL_ACTIONS,
  GUARDRAIL_ACTIONS_TAKEN,
  GUARDRAIL_CALLERS,
  GUARDRAIL_CHECK_IDS,
  GUARDRAIL_CHECK_VERDICTS,
  GUARDRAIL_CORRELATION_HEADERS,
  GUARDRAIL_DECISIONS,
  GUARDRAIL_DIRECTIONS,
  GUARDRAIL_ERROR_CODES,
  GUARDRAIL_ITEM_STATUSES,
  GUARDRAIL_JUDGE_CHECK_IDS,
  GUARDRAIL_REGION_TRUSTS,
  isGuardrailCheckId,
} from '../guardrail-vocabulary.js';

const read = (relative: string): any => JSON.parse(readFileSync(path.resolve(__dirname, relative), 'utf8'));
const vocabulary = read('../../../../tests/contracts/guardrail-vocabulary.fixture.json');
const availability = read('../../../../apps/guardrail/src/guardrail/tests/contracts/availability-catalogue.json');
const runEvents = read('../../../../tests/contracts/guardrail-run-events.fixture.json');

describe('guardrail vocabulary — fixture parity', () => {
  it('check ids match the fixture AND the availability catalogue, in order', () => {
    expect([...GUARDRAIL_CHECK_IDS]).toEqual(vocabulary.checkIds);
    expect([...GUARDRAIL_CHECK_IDS]).toEqual(availability.policies.map((p: { id: string }) => p.id));
    expect([...GUARDRAIL_JUDGE_CHECK_IDS]).toEqual(vocabulary.judgeCheckIds);
    for (const id of GUARDRAIL_JUDGE_CHECK_IDS) expect(GUARDRAIL_CHECK_IDS).toContain(id);
  });

  it('every enum matches the fixture', () => {
    expect([...GUARDRAIL_DIRECTIONS]).toEqual(vocabulary.directions);
    expect([...GUARDRAIL_ACTIONS]).toEqual(vocabulary.actions);
    expect([...GUARDRAIL_DECISIONS]).toEqual(vocabulary.decisions);
    expect([...GUARDRAIL_CHECK_VERDICTS]).toEqual(vocabulary.checkVerdicts);
    expect([...GUARDRAIL_ACTIONS_TAKEN]).toEqual(vocabulary.actionsTaken);
    expect([...GUARDRAIL_ITEM_STATUSES]).toEqual(vocabulary.itemStatuses);
    expect([...GUARDRAIL_REGION_TRUSTS]).toEqual(vocabulary.regionTrusts);
    expect([...GUARDRAIL_CALLERS]).toEqual(vocabulary.callers);
    expect([...GUARDRAIL_HOLD_RESOLUTIONS]).toEqual(vocabulary.holdResolutions);
    expect([...GUARDRAIL_ACKNOWLEDGEMENT_VIAS]).toEqual(vocabulary.acknowledgementVias);
  });

  it('correlation headers, paths, limits and error codes match the fixture', () => {
    expect(GUARDRAIL_CORRELATION_HEADERS).toEqual(vocabulary.correlationHeaders);
    expect(GUARDRAIL_EVALUATIONS_PATH).toBe(vocabulary.evaluation.path);
    expect(GUARDRAIL_EVALUATION_BATCH_MAX).toBe(vocabulary.evaluation.batchMax);
    expect(GUARDRAIL_HOLD_RESUME_PATH).toBe(vocabulary.hold.resumePath);
    expect(guardrailHoldResumePath('c-1')).toBe('consultations/c-1/guardrail-hold/resume');
    expect(GUARDRAIL_ERROR_CODES).toEqual(vocabulary.errorCodes);
  });

  it('isGuardrailCheckId accepts the catalogue and nothing else', () => {
    expect(isGuardrailCheckId('leakage_judge')).toBe(true);
    expect(isGuardrailCheckId('medical_validation')).toBe(true);
    expect(isGuardrailCheckId('vibes')).toBe(false);
    expect(isGuardrailCheckId(undefined)).toBe(false);
  });
});

describe('GuardrailNotice v1 — fixture parity', () => {
  it('notice vocabulary matches the fixture', () => {
    expect(GUARDRAIL_NOTICE_SCHEMA_VERSION).toBe(vocabulary.notice.schemaVersion);
    expect([...GUARDRAIL_NOTICE_TYPES]).toEqual(vocabulary.notice.types);
    expect(GUARDRAIL_NOTICE_TYPE_ACTION).toEqual(vocabulary.notice.typeAction);
    expect([...GUARDRAIL_NOTICE_ACTIONS]).toEqual(vocabulary.notice.actions);
    expect([...GUARDRAIL_NOTICE_SEVERITIES]).toEqual(vocabulary.notice.severities);
    expect([...GUARDRAIL_NOTICE_MESSAGE_KEYS]).toEqual(vocabulary.notice.messageKeys);
    expect(GUARDRAIL_NOTICE_DEFAULT_MESSAGES).toEqual(vocabulary.notice.defaultMessages);
    expect(GUARDRAIL_BLOCKED_PROBLEM_TYPE).toBe(vocabulary.notice.blockedProblemType);
  });

  it('every message key belongs to exactly one notice type and has a fixed default message', () => {
    for (const key of GUARDRAIL_NOTICE_MESSAGE_KEYS) {
      expect(GUARDRAIL_NOTICE_TYPES.filter((type) => key.startsWith(`${type}.`)), key).toHaveLength(1);
      expect(guardrailNoticeDefaultMessage(key).length).toBeGreaterThan(0);
    }
  });

  it.each((runEvents.notices as GuardrailNotice[]).map((notice) => [notice.messageKey, notice] as const))(
    'fixture notice %s uses only frozen vocabulary',
    (_key, notice) => {
      expect(notice.schemaVersion).toBe(GUARDRAIL_NOTICE_SCHEMA_VERSION);
      expect(GUARDRAIL_NOTICE_TYPES).toContain(notice.type);
      expect(notice.action).toBe(GUARDRAIL_NOTICE_TYPE_ACTION[notice.type]);
      expect(GUARDRAIL_DIRECTIONS).toContain(notice.direction);
      expect(notice.messageKey.startsWith(`${notice.type}.`)).toBe(true);
      expect(notice.defaultMessage).toBe(guardrailNoticeDefaultMessage(notice.messageKey));
      for (const check of notice.checks) {
        expect(GUARDRAIL_CHECK_IDS).toContain(check.checkId);
        expect(GUARDRAIL_NOTICE_SEVERITIES).toContain(check.severity);
      }
    },
  );
});

describe('consultation processing reasons — guardrail hold', () => {
  it('declares the two resumable hold reasons, matching the fixture', () => {
    expect(GUARDRAIL_HOLD_REASON).toBe(vocabulary.processingReasons.guardrailHold);
    expect(EGRESS_REDACTION_UNAVAILABLE_REASON).toBe(vocabulary.processingReasons.egressRedactionUnavailable);
    expect([...GUARDRAIL_HOLD_PROCESSING_REASONS]).toEqual([GUARDRAIL_HOLD_REASON, EGRESS_REDACTION_UNAVAILABLE_REASON]);
    expect(isGuardrailHoldReason(GUARDRAIL_HOLD_REASON)).toBe(true);
    expect(isGuardrailHoldReason(EGRESS_REDACTION_UNAVAILABLE_REASON)).toBe(true);
    expect(isGuardrailHoldReason(NOTE_READY_REASON)).toBe(false);
    expect(isGuardrailHoldReason(null)).toBe(false);
  });

  it('a held consultation is never "note ready", even when AWAITING_REVIEW after stop', () => {
    for (const reason of GUARDRAIL_HOLD_PROCESSING_REASONS) {
      expect(isNoteReady({ status: 'STOPPED', processing: 'AWAITING_REVIEW', processingReason: reason }), reason).toBe(false);
    }
    // The pre-existing AWAITING_REVIEW meaning is unchanged.
    expect(isNoteReady({ status: 'STOPPED', processing: 'AWAITING_REVIEW' })).toBe(true);
    expect(isNoteReady({ status: 'STOPPED', processing: 'AWAITING_REVIEW', processingReason: 'SOMETHING_ELSE' })).toBe(true);
  });
});
