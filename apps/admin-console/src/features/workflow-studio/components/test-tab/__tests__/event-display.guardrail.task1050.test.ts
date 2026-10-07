/**
 * TASK-1050 W3b round 2 — the Test tab's Events list reads the guardrail additions: `guardrail.notice`
 * (a Guardrails event, flagged as a warning) and `run.paused` (a Steps event, flagged), and the WARN /
 * IGNORE actions of a screen.
 */
import { describe, expect, it } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES } from '@arcaai/types';
import type { RunEvent } from '@/shared/sandbox/api/run-protocol';
import { categoriesOf, describeEvent } from '../lib/event-display';

const labelOf = (nodeId: string) => (nodeId === 'n_note' ? 'Note' : nodeId);

const notice = {
  seq: 5,
  runId: 'r',
  type: 'guardrail.notice',
  ts: '2026-10-07T09:15:00.000Z',
  nodeId: 'n_note',
  data: {
    schemaVersion: 1,
    noticeId: 'n-1',
    type: 'guardrail.blocked',
    direction: 'outbound',
    action: 'block',
    checks: [{ checkId: 'leakage_judge', category: 'system_prompt', severity: 'high' }],
    itemIds: [],
    messageKey: 'guardrail.blocked.outbound',
    defaultMessage: GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.outbound'],
    requiresAcknowledgement: false,
    resumable: true,
    policyVersion: 'pv',
    occurredAt: '2026-10-07T09:15:00.000Z',
  },
} as unknown as RunEvent;

const paused = {
  seq: 6,
  runId: 'r',
  type: 'run.paused',
  ts: '2026-10-07T09:15:00.000Z',
  data: { reason: 'guardrail_hold', noticeId: 'n-1', nodeId: 'n_note' },
} as RunEvent;

describe('event display — guardrail', () => {
  it('categorises a notice under Guardrails and a pause under Steps, both flagged', () => {
    expect(categoriesOf(notice)).toEqual(['guardrails', 'warnings']);
    expect(categoriesOf(paused)).toEqual(['steps', 'warnings']);
  });

  it('describes the notice by type, direction and checks, and the pause by its step', () => {
    expect(describeEvent(notice, labelOf)).toBe('Blocked notice (outbound): Leakage (judge)');
    expect(describeEvent(paused, labelOf)).toBe('Paused at Note on a guardrail hold');
  });

  it('flags a WARN screen and describes it', () => {
    const warn = { seq: 4, runId: 'r', type: 'guardrail.inbound', ts: 't', nodeId: 'n_note', data: { action: 'WARN', detected: 1 } } as RunEvent;
    expect(categoriesOf(warn)).toEqual(['guardrails', 'warnings']);
    expect(describeEvent(warn, labelOf)).toBe('Inbound guardrail: WARN, 1 finding');
  });
});
