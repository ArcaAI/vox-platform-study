/**
 * TASK-1050 W2g — the live lane's guardrail helpers (`live-guardrail.ts`), pure.
 *
 *   - correlation headers (`X-Hope-*`) and the `region_items` wire;
 *   - reading TEXT's notices off a 200 body, and its two STOPS off an error (422 block, 503 redaction hold);
 *   - the per-(consultation, checkId, itemId, policyVersion) dedupe key;
 *   - the composer exclusion, applied through W2e's shared keep predicate;
 *   - F7: the live lane's own previous note travels under ONE region key;
 *   - the two new degrade codes.
 */
import { describe, expect, it } from 'vitest';
import {
  EGRESS_REDACTION_UNAVAILABLE_REASON,
  GUARDRAIL_BLOCKED_PROBLEM_TYPE,
  GUARDRAIL_HOLD_REASON,
  guardrailNoticeDefaultMessage,
  type GuardrailNotice,
} from '@arcaai/types';
import {
  LIVE_GUARDRAIL_NOTICE_EVENT,
  LIVE_SELF_NOTE_REGION_KEY,
  liveCorrelationHeaders,
  liveExclusionSet,
  noticeDedupeKeys,
  regionItemsWire,
  textGuardrailStop,
  textResponseNotices,
} from '../live-guardrail';
import { isGuardrailExcludedItem } from '../../../guardrail-notice/guardrail-item-exclusion';
import {
  degradeCode,
  LIVE_DEGRADE_CODES,
  LIVE_DEGRADE_FALLBACK,
  LIVE_DEGRADE_GUARDRAIL_BLOCKED,
  LIVE_DEGRADE_REDACTION_UNAVAILABLE,
} from '../degrade-codes';

const CID = 'consultation-1050';

function notice(overrides: Partial<GuardrailNotice> = {}): GuardrailNotice {
  return {
    schemaVersion: 1,
    noticeId: '01900000-0000-7000-8000-000000000001',
    type: 'guardrail.warning',
    direction: 'inbound',
    action: 'warn',
    checks: [{ checkId: 'unsafe_content_judge', category: 'violence', severity: 'medium' }],
    consultationId: CID,
    itemIds: ['seg-1'],
    messageKey: 'guardrail.warning.generic',
    defaultMessage: guardrailNoticeDefaultMessage('guardrail.warning.generic'),
    requiresAcknowledgement: true,
    resumable: false,
    policyVersion: 'pv-1',
    occurredAt: '2026-10-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('correlation headers', () => {
  it('names the consultation, the snapshot item and the run key with the frozen spellings', () => {
    expect(liveCorrelationHeaders({ consultationId: CID, itemId: 'snap-1', runKey: 'trajectory:s:r:1' })).toEqual({
      'X-Hope-Consultation-Id': CID,
      'X-Hope-Item-Id': 'snap-1',
      'X-Hope-Run-Key': 'trajectory:s:r:1',
    });
  });

  it('omits what is not known rather than sending an empty header', () => {
    expect(liveCorrelationHeaders({ consultationId: CID, itemId: null })).toEqual({ 'X-Hope-Consultation-Id': CID });
    expect(liveCorrelationHeaders({ consultationId: '' })).toEqual({});
  });
});

describe('region_items wire', () => {
  it('drops empty regions and returns undefined when nothing is left', () => {
    expect(regionItemsWire({ transcript: [{ itemId: 'a', itemVersion: 1 }], current_note: [] })).toEqual({
      transcript: [{ itemId: 'a', itemVersion: 1 }],
    });
    expect(regionItemsWire({ transcript: [] })).toBeUndefined();
    expect(regionItemsWire(undefined)).toBeUndefined();
  });
});

describe('TEXT notices on a 200 body', () => {
  it('reads `guardrail_notices` (snake, the TEXT wire) and `guardrailNotices` (camel)', () => {
    expect(textResponseNotices({ summary: 'x', guardrail_notices: [notice()] })).toHaveLength(1);
    expect(textResponseNotices({ guardrailNotices: [notice()] })).toHaveLength(1);
  });

  it('drops anything that is not a notice (no id, unknown type)', () => {
    expect(textResponseNotices({ guardrail_notices: [{ noticeId: 'x' }, { ...notice(), type: 'nope' }, 'junk'] })).toEqual([]);
    expect(textResponseNotices(null)).toEqual([]);
  });
});

describe('TEXT guardrail stops on an error', () => {
  const axiosError = (status: number, data: unknown) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

  it('a 422 guardrail-blocked body is a GUARDRAIL_HOLD stop carrying its notice', () => {
    const blocked = notice({ type: 'guardrail.blocked', action: 'block', messageKey: 'guardrail.blocked.inbound', resumable: true });
    const stop = textGuardrailStop(
      axiosError(422, {
        detail: 'Content blocked by safety filter',
        error_code: 'CONTENT_BLOCKED',
        type: GUARDRAIL_BLOCKED_PROBLEM_TYPE,
        guardrailNotice: blocked,
        guardrailEvaluationIds: ['ev-1'],
      }),
    );
    expect(stop).toEqual({ reason: GUARDRAIL_HOLD_REASON, notice: blocked, evaluationIds: ['ev-1'] });
  });

  it('a 503 EGRESS_REDACTION_UNAVAILABLE is a redaction-hold stop', () => {
    const hold = notice({ type: 'guardrail.blocked', action: 'block', messageKey: 'guardrail.blocked.redaction_unavailable', checks: [] });
    const stop = textGuardrailStop(axiosError(503, { error_code: 'EGRESS_REDACTION_UNAVAILABLE', retryable: true, guardrailNotice: hold }));
    expect(stop?.reason).toBe(EGRESS_REDACTION_UNAVAILABLE_REASON);
    expect(stop?.notice).toEqual(hold);
  });

  it('any other failure is not a guardrail stop', () => {
    expect(textGuardrailStop(axiosError(422, { error_code: 'CONTENT_BLOCKED' }))).toBeNull();
    expect(textGuardrailStop(axiosError(503, { error_code: 'GUARDRAIL_UNAVAILABLE' }))).toBeNull();
    expect(textGuardrailStop(new Error('boom'))).toBeNull();
  });
});

describe('notice dedupe — one per (consultation, checkId, itemId, policyVersion)', () => {
  it('one key per check x item', () => {
    const keys = noticeDedupeKeys(
      notice({
        checks: [
          { checkId: 'unsafe_content_judge', severity: 'low' },
          { checkId: 'injection_judge', severity: 'low' },
        ],
        itemIds: ['a', 'b'],
      }),
      CID,
    );
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    for (const key of keys) expect(key.startsWith(`${CID}|`)).toBe(true);
  });

  it('a new policy version is a new key; a new noticeId for the same triple is not', () => {
    const [a] = noticeDedupeKeys(notice(), CID);
    const [b] = noticeDedupeKeys(notice({ noticeId: 'another' }), CID);
    const [c] = noticeDedupeKeys(notice({ policyVersion: 'pv-2' }), CID);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('a notice with no checks (the redaction hold) still has a key, by its message key', () => {
    expect(noticeDedupeKeys(notice({ checks: [], itemIds: [], messageKey: 'guardrail.blocked.redaction_unavailable' }), CID)).toEqual([
      `${CID}|guardrail.blocked.redaction_unavailable||pv-1`,
    ]);
  });
});

describe('composer exclusion — the SHARED W2e keep predicate', () => {
  it('the live lane carries no predicate of its own', async () => {
    const live = (await import('../live-guardrail')) as Record<string, unknown>;
    expect(live.liveContextExcluded, 'use guardrailKeepFilter (guardrail-notice/guardrail-item-exclusion.ts)').toBeUndefined();
  });

  it('applies a keep predicate: excluded ids, and the segment keys of excluded transcript segments', () => {
    const excluded = new Set(['seg-b']);
    const keep = (item: { id: string; guardrailStatus?: string | null }) => !isGuardrailExcludedItem(item, excluded);
    const set = liveExclusionSet(
      [
        { id: 'note-w', guardrailStatus: 'WITHHELD' },
        { id: 'seg-b', guardrailStatus: 'BLOCKED', segmentKey: 'stt-1:4' },
        { id: 'seg-open', guardrailStatus: 'BLOCKED', segmentKey: 'stt-1:5' },
        { id: 'note-warned', guardrailStatus: 'WARNED' },
      ],
      keep,
    );
    expect([...set.itemIds].sort()).toEqual(['note-w', 'seg-b']);
    expect([...set.segmentKeys]).toEqual(['stt-1:4']);
  });
});

describe('F7 — the previous note is ONE region', () => {
  it('is keyed `current_note`, the key the guardrail skip list must name', () => {
    expect(LIVE_SELF_NOTE_REGION_KEY).toBe('current_note');
    expect(LIVE_GUARDRAIL_NOTICE_EVENT).toBe('guardrail.notice');
  });
});

describe('degrade codes for the two guardrail stops', () => {
  const axiosError = (status: number, data: unknown) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

  it('a guardrail block is `guardrail_blocked`, not `generation_failed`', () => {
    expect(degradeCode(axiosError(422, { error_code: 'CONTENT_BLOCKED', type: GUARDRAIL_BLOCKED_PROBLEM_TYPE }), LIVE_DEGRADE_FALLBACK)).toBe(
      LIVE_DEGRADE_GUARDRAIL_BLOCKED,
    );
  });

  it('the redaction hold is `redaction_unavailable`, not `text_unavailable`', () => {
    expect(degradeCode(axiosError(503, { error_code: 'EGRESS_REDACTION_UNAVAILABLE' }), LIVE_DEGRADE_FALLBACK)).toBe(
      LIVE_DEGRADE_REDACTION_UNAVAILABLE,
    );
  });

  it('both are in the closed vocabulary', () => {
    expect(LIVE_DEGRADE_CODES).toContain(LIVE_DEGRADE_GUARDRAIL_BLOCKED);
    expect(LIVE_DEGRADE_CODES).toContain(LIVE_DEGRADE_REDACTION_UNAVAILABLE);
  });
});
