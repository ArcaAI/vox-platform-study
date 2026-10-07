/**
 * TASK-1050 W2d — the deprecated resumable streams (`streamRun`, `runAndStream`, `waitForRun`) deliver
 * `guardrail.notice` frames to `onGuardrailNotice` and never treat `run.paused` as the end.
 */

import { describe, expect, it, vi } from 'vitest';
import { HopeClient } from '../../client';

const BASE = 'http://localhost:8868';
const NOTICE = {
  schemaVersion: 1,
  noticeId: '01927f6e-9999-7000-8000-0000000000aa',
  type: 'guardrail.warning',
  direction: 'inbound',
  action: 'warn',
  checks: [{ checkId: 'unsafe_content_judge', category: 'violence', severity: 'medium' }],
  itemIds: [],
  messageKey: 'guardrail.warning.generic',
  defaultMessage: 'A safety check flagged this content. Review it before you rely on it.',
  requiresAcknowledgement: true,
  resumable: false,
  policyVersion: 'pv-1',
  occurredAt: '2026-10-07T09:15:00.000Z',
};

const frame = (type: string, body: Record<string, unknown>, id?: string): string =>
  `event: ${type}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify({ schemaVersion: 1, id: 'e', tenantId: 't', type, occurredAt: 'x', correlationId: 'run-1', causationId: null, idempotencyKey: 'k', ...body })}\n\n`;

const completedPayload = { runId: 'run-1', slug: 'visit-summary', workflowVersionNumber: 1, status: 'COMPLETED', stages: [], startedAt: null, endedAt: null };

function client(frames: string[]) {
  const impl = vi.fn(async () => new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  return new HopeClient({ baseUrl: BASE, apiKey: 'k', fetch: impl as unknown as typeof fetch, maxRetries: 0 });
}

describe('legacy run streams — guardrail notices', () => {
  it('streamRun announces a notice once (v2-shaped data and legacy-shaped payload) and still yields every frame', async () => {
    const hope = client([
      frame('guardrail.notice', { data: NOTICE }, '1'),
      frame('guardrail.notice', { payload: NOTICE }, '2'),
      frame('run.paused', { data: { reason: 'guardrail_hold', noticeId: NOTICE.noticeId, nodeId: 'n' } }, '3'),
      frame('workflow.run.completed', { payload: completedPayload }, '4'),
    ]);
    const seen: string[] = [];
    const types: string[] = [];
    for await (const event of hope.workflows.streamRun('visit-summary', 'run-1', { onGuardrailNotice: (n) => seen.push(n.noticeId) })) types.push(event.type);
    expect(seen).toEqual([NOTICE.noticeId]);
    expect(types).toEqual(['guardrail.notice', 'guardrail.notice', 'run.paused', 'workflow.run.completed']);
  });

  it('waitForRun waits through run.paused and resolves on the real terminal frame', async () => {
    const hope = client([
      frame('run.paused', { data: { reason: 'guardrail_hold', noticeId: 'n1', nodeId: 'n' }, payload: { status: 'PAUSED' } }, '1'),
      frame('workflow.run.completed', { payload: completedPayload }, '2'),
    ]);
    const notices: string[] = [];
    const status = await hope.workflows.waitForRun('visit-summary', 'run-1', { onGuardrailNotice: (n) => notices.push(n.noticeId) });
    expect(status.status).toBe('COMPLETED');
    expect(notices).toEqual([]);
  });

  it('ignores a malformed notice instead of throwing', async () => {
    const hope = client([frame('guardrail.notice', { data: { nope: true } }, '1'), frame('workflow.run.completed', { payload: completedPayload }, '2')]);
    const seen: string[] = [];
    for await (const _ of hope.workflows.streamRun('visit-summary', 'run-1', { onGuardrailNotice: (n) => seen.push(n.noticeId) })) void _;
    expect(seen).toEqual([]);
  });

  it('without a callback the stream is returned untouched', async () => {
    const hope = client([frame('workflow.run.completed', { payload: completedPayload }, '1')]);
    const types: string[] = [];
    for await (const event of hope.workflows.streamRun('visit-summary', 'run-1')) types.push(event.type);
    expect(types).toEqual(['workflow.run.completed']);
  });
});
