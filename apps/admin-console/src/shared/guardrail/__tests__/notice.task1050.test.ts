/**
 * TASK-1050 W3b — the console's pure guardrail-notice helpers: validation against the frozen
 * contract, copy keyed by `messageKey`, dedupe by `noticeId`, the per-check toast dedupe (OD-15),
 * the allowed hold resolutions, and the block-floor parity with the platform catalogue.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES, type GuardrailNotice } from '@arcaai/types';
import {
  BLOCK_FLOOR_CHECK_IDS,
  allowedHoldResolutions,
  createNoticeDeduper,
  guardrailNoticeCopy,
  isWarningNotice,
  mergeGuardrailNotices,
  toGuardrailNotice,
  toGuardrailNotices,
} from '../notice';

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../../tests/contracts/guardrail-run-events.fixture.json', import.meta.url)), 'utf8'),
) as { notices: GuardrailNotice[] };

const CATALOGUE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../../apps/guardrail/src/guardrail/tests/contracts/availability-catalogue.json', import.meta.url)),
    'utf8',
  ),
) as { policies: Array<{ id: string; locked: boolean; platformDefaultAction: string }> };

function notice(partial: Partial<GuardrailNotice> = {}): GuardrailNotice {
  return {
    schemaVersion: 1,
    noticeId: 'n-1',
    type: 'guardrail.warning',
    direction: 'inbound',
    action: 'warn',
    checks: [{ checkId: 'unsafe_content_judge', category: 'violence', severity: 'medium' }],
    itemIds: ['item-1'],
    messageKey: 'guardrail.warning.generic',
    defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic'],
    requiresAcknowledgement: true,
    resumable: false,
    policyVersion: 'pv-1',
    occurredAt: '2026-10-07T09:15:00.000Z',
    ...partial,
  };
}

describe('toGuardrailNotice', () => {
  it('accepts every frozen fixture notice', () => {
    for (const fixture of FIXTURE.notices) expect(toGuardrailNotice(fixture), fixture.noticeId).not.toBeNull();
  });

  it('refuses a notice whose defaultMessage is not the fixed label of its key (free text never renders)', () => {
    expect(toGuardrailNotice({ ...notice(), defaultMessage: 'Patient said: ...' })).toBeNull();
  });

  it('refuses an unknown type, an unknown messageKey, a key of another type and a wrong action', () => {
    expect(toGuardrailNotice({ ...notice(), type: 'guardrail.oops' })).toBeNull();
    expect(toGuardrailNotice({ ...notice(), messageKey: 'guardrail.warning.custom' })).toBeNull();
    expect(
      toGuardrailNotice({
        ...notice(),
        messageKey: 'guardrail.blocked.inbound',
        defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.inbound'],
      }),
    ).toBeNull();
    expect(toGuardrailNotice({ ...notice(), action: 'block' })).toBeNull();
    expect(toGuardrailNotice(null)).toBeNull();
    expect(toGuardrailNotice({ noticeId: '' })).toBeNull();
  });

  it('reads a list from a body in either casing, dropping invalid entries', () => {
    expect(toGuardrailNotices({ guardrailNotices: [notice(), { bad: true }] })).toHaveLength(1);
    expect(toGuardrailNotices({ guardrail_notices: [notice()] })).toHaveLength(1);
    expect(toGuardrailNotices({ notices: [notice()] })).toHaveLength(1);
    expect(toGuardrailNotices([notice()])).toHaveLength(1);
    expect(toGuardrailNotices(undefined)).toEqual([]);
  });
});

describe('copy and classification', () => {
  it('renders copy from messageKey, never from the producer', () => {
    expect(guardrailNoticeCopy(notice())).toBe(GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.warning.generic']);
  });

  it('treats warning and unverified as warn weight, blocked as not', () => {
    expect(isWarningNotice(notice())).toBe(true);
    expect(
      isWarningNotice(
        notice({
          type: 'guardrail.unverified',
          messageKey: 'guardrail.unverified.generic',
          defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.unverified.generic'],
        }),
      ),
    ).toBe(true);
    expect(isWarningNotice(FIXTURE.notices.find((n) => n.type === 'guardrail.blocked') as GuardrailNotice)).toBe(false);
  });
});

describe('mergeGuardrailNotices', () => {
  it('keeps one notice per noticeId, first-seen order, a repeat replaces the earlier entry', () => {
    const a = notice({ noticeId: 'a' });
    const b = notice({ noticeId: 'b' });
    const aAgain = notice({ noticeId: 'a', requiresAcknowledgement: false });
    const merged = mergeGuardrailNotices([a], [b, aAgain, b]);
    expect(merged.map((n) => n.noticeId)).toEqual(['a', 'b']);
    expect(merged[0].requiresAcknowledgement).toBe(false);
  });

  it('returns the same array when nothing changed (no re-render)', () => {
    const current = [notice()];
    expect(mergeGuardrailNotices(current, [notice()])).toBe(current);
  });
});

describe('createNoticeDeduper (OD-15: one toast per check per consultation)', () => {
  it('fires once per (scope, check); a new policy notice for the same check does not re-fire', () => {
    const dedupe = createNoticeDeduper();
    expect(dedupe.firstSeen('c1', notice({ noticeId: 'x' }))).toBe(true);
    expect(dedupe.firstSeen('c1', notice({ noticeId: 'y' }))).toBe(false);
    expect(dedupe.firstSeen('c2', notice({ noticeId: 'z' }))).toBe(true);
    expect(dedupe.firstSeen('c1', notice({ noticeId: 'w', checks: [{ checkId: 'leakage_judge', severity: 'low' }] }))).toBe(true);
  });

  it('keys a check-less notice on its messageKey', () => {
    const dedupe = createNoticeDeduper();
    const egress = FIXTURE.notices.find((n) => n.messageKey === 'guardrail.blocked.redaction_unavailable') as GuardrailNotice;
    expect(dedupe.firstSeen('c1', egress)).toBe(true);
    expect(dedupe.firstSeen('c1', { ...egress, noticeId: 'other' })).toBe(false);
  });
});

describe('allowedHoldResolutions', () => {
  const blocked = (checkId: string) =>
    notice({
      type: 'guardrail.blocked',
      action: 'block',
      resumable: true,
      messageKey: 'guardrail.blocked.inbound',
      defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.inbound'],
      checks: [{ checkId: checkId as GuardrailNotice['checks'][number]['checkId'], severity: 'high' }],
    });

  it('offers all three for a tenant-set block', () => {
    expect(allowedHoldResolutions(blocked('injection_judge'))).toEqual(['item_excluded', 'item_edited', 'acknowledged']);
  });

  it('never offers the acknowledged override for the locked medical check', () => {
    expect(allowedHoldResolutions(blocked('medical_validation'))).toEqual(['item_excluded', 'item_edited']);
    expect(
      allowedHoldResolutions(
        notice({
          type: 'guardrail.blocked',
          action: 'block',
          resumable: true,
          checks: [],
          messageKey: 'guardrail.blocked.not_medical',
          defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.not_medical'],
        }),
      ),
    ).toEqual(['item_excluded', 'item_edited']);
  });

  it('offers only a retry for the egress-redaction hold, and nothing for a non-resumable notice', () => {
    const egress = FIXTURE.notices.find((n) => n.messageKey === 'guardrail.blocked.redaction_unavailable') as GuardrailNotice;
    expect(allowedHoldResolutions(egress)).toEqual(['acknowledged']);
    expect(allowedHoldResolutions(notice())).toEqual([]);
  });

  it('mirrors the platform catalogue: the block floor is exactly the locked checks whose action is block', () => {
    const floor = CATALOGUE.policies.filter((policy) => policy.locked && policy.platformDefaultAction === 'block').map((policy) => policy.id);
    expect([...BLOCK_FLOOR_CHECK_IDS].sort()).toEqual(floor.sort());
  });
});
