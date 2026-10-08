/**
 * TASK-1050 finding D (round 2) — an output item created AFTER its generation answered is marked from
 * the notices TEXT returned with that generation: an OUTBOUND `guardrail.warning` → WARNED. An
 * `unverified` notice adds no marker, an inbound one is about the sources, and a stronger marker is
 * never downgraded. Status column only (no `_version`).
 */
import { describe, expect, it, vi } from 'vitest';
import { markGeneratedItemFromNotices, textGenerationNotices } from '../guardrail-generated-item';

const notice = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  noticeId: 'n-1',
  type: 'guardrail.warning',
  direction: 'outbound',
  action: 'warn',
  checks: [{ checkId: 'pii_leak', category: 'healthcare_facility' }],
  consultationId: 'c-1',
  itemIds: [],
  messageKey: 'guardrail.warning.generic',
  defaultMessage: 'x',
  requiresAcknowledgement: true,
  resumable: false,
  policyVersion: 'pv-1',
  occurredAt: '2026-10-08T00:00:00.000Z',
  ...overrides,
});

const deps = () => ({ contextItems: { setGuardrailStatus: vi.fn(async () => undefined) } });
const item = (overrides: Record<string, unknown> = {}) => ({ id: 'out-1', consultationId: 'c-1', guardrailStatus: 'CLEAN', ...overrides });

describe('markGeneratedItemFromNotices', () => {
  it('an outbound warning marks the generated item WARNED, in the caller`s transaction', async () => {
    const d = deps();
    await expect(markGeneratedItemFromNotices(d, item(), [notice()] as never, 'tx')).resolves.toBe(true);
    expect(d.contextItems.setGuardrailStatus).toHaveBeenCalledWith('out-1', 'WARNED', 'tx');
  });

  it('an outbound warning naming THIS item marks it; one naming another item does not', async () => {
    const d = deps();
    await expect(markGeneratedItemFromNotices(d, item(), [notice({ itemIds: ['out-1'] })] as never)).resolves.toBe(true);
    await expect(markGeneratedItemFromNotices(d, item(), [notice({ itemIds: ['other'] })] as never)).resolves.toBe(false);
  });

  it('unverified, inbound, and another consultation`s notices add no marker', async () => {
    const d = deps();
    const none = [notice({ type: 'guardrail.unverified', action: 'warn' }), notice({ direction: 'inbound' }), notice({ consultationId: 'c-2' })];
    await expect(markGeneratedItemFromNotices(d, item(), none as never)).resolves.toBe(false);
    expect(d.contextItems.setGuardrailStatus).not.toHaveBeenCalled();
  });

  it('never downgrades a stronger marker, and does nothing for an already-WARNED item', async () => {
    const d = deps();
    for (const status of ['WARNED', 'BLOCKED', 'WITHHELD']) {
      await expect(markGeneratedItemFromNotices(d, item({ guardrailStatus: status }), [notice()] as never)).resolves.toBe(false);
    }
    expect(d.contextItems.setGuardrailStatus).not.toHaveBeenCalled();
  });

  it('no notices, no write', async () => {
    const d = deps();
    await expect(markGeneratedItemFromNotices(d, item(), undefined)).resolves.toBe(false);
    expect(d.contextItems.setGuardrailStatus).not.toHaveBeenCalled();
  });
});

describe('textGenerationNotices', () => {
  it('reads `guardrail_notices` or `guardrailNotices` off a TEXT 200 body, dropping malformed entries', () => {
    expect(textGenerationNotices({ guardrail_notices: [notice(), { junk: true }] })).toHaveLength(1);
    expect(textGenerationNotices({ guardrailNotices: [notice()] })).toHaveLength(1);
    expect(textGenerationNotices(null)).toEqual([]);
  });
});
