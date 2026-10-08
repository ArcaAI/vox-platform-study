/**
 * TASK-1050 follow-up F — an output released by a `acknowledged` override of an OUTBOUND block is marked
 * WARNED (it proceeded on a safety override), never CLEAN. The marker rules are the existing ones:
 * the CURRENT version of the just-persisted item only, never a downgrade, never `_version`.
 */
import { describe, expect, it, vi } from 'vitest';
import { markOverrideReleasedItem } from '../guardrail-override-release';

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';

function notice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n-1',
    tenantId: TENANT,
    consultationId: CONSULTATION,
    runId: 'run-1',
    type: 'BLOCKED',
    direction: 'OUTBOUND',
    status: 'RESOLVED',
    resolution: 'acknowledged',
    messageKey: 'guardrail.blocked.outbound',
    resolvedAt: new Date('2026-10-08T10:00:00Z'),
    ...overrides,
  };
}

function setup(rows: unknown[]) {
  const notices = { findAll: vi.fn(async () => rows) };
  const contextItems = { setGuardrailStatus: vi.fn(async () => undefined) };
  return { notices, contextItems };
}

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'note-1',
  tenantId: TENANT,
  consultationId: CONSULTATION,
  guardrailStatus: 'CLEAN',
  createdAt: new Date('2026-10-08T10:00:05Z'),
  ...overrides,
});

describe('markOverrideReleasedItem', () => {
  it('queries only resolved, acknowledged, outbound blocks of this consultation and marks the released item WARNED', async () => {
    const h = setup([notice()]);
    const marked = await markOverrideReleasedItem(h, item(), { runId: 'run-1' }, 'tx');
    expect(marked).toBe(true);
    expect(h.contextItems.setGuardrailStatus).toHaveBeenCalledWith('note-1', 'WARNED', 'tx');
    const [args] = h.notices.findAll.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(args.where).toMatchObject({
      tenantId: TENANT,
      consultationId: CONSULTATION,
      type: 'BLOCKED',
      direction: 'OUTBOUND',
      status: 'RESOLVED',
      resolution: 'acknowledged',
    });
  });

  it('never downgrades: a BLOCKED or WITHHELD item keeps its marker', async () => {
    for (const guardrailStatus of ['WARNED', 'BLOCKED', 'WITHHELD']) {
      const h = setup([notice()]);
      expect(await markOverrideReleasedItem(h, item({ guardrailStatus }), {})).toBe(false);
      expect(h.contextItems.setGuardrailStatus).not.toHaveBeenCalled();
    }
  });

  it('ignores the egress-redaction retry (a privacy retry is not a safety override)', async () => {
    const h = setup([notice({ messageKey: 'guardrail.blocked.redaction_unavailable' })]);
    expect(await markOverrideReleasedItem(h, item(), {})).toBe(false);
  });

  it('ignores a notice resolved AFTER the item was created, and one of another run', async () => {
    const later = setup([notice({ resolvedAt: new Date('2026-10-08T10:05:00Z') })]);
    expect(await markOverrideReleasedItem(later, item(), {})).toBe(false);
    const otherRun = setup([notice({ runId: 'run-9' })]);
    expect(await markOverrideReleasedItem(otherRun, item(), { runId: 'run-1' })).toBe(false);
    expect(otherRun.contextItems.setGuardrailStatus).not.toHaveBeenCalled();
  });

  it('never marks another tenant`s or consultation`s item', async () => {
    const h = setup([notice()]);
    expect(await markOverrideReleasedItem(h, item({ tenantId: 'tenant-2' }), {})).toBe(false);
    expect(await markOverrideReleasedItem(h, item({ consultationId: 'c-2' }), {})).toBe(false);
    expect(h.contextItems.setGuardrailStatus).not.toHaveBeenCalled();
  });

  it('does nothing without an override behind the item', async () => {
    const h = setup([]);
    expect(await markOverrideReleasedItem(h, item(), {})).toBe(false);
    expect(h.contextItems.setGuardrailStatus).not.toHaveBeenCalled();
  });
});
