/**
 * TASK-1048 — the stream-session creation result carries the gateway's non-fatal ASR `warnings`,
 * and a `degraded` socket status frame is recognisable with a typed `reason`.
 */

import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../../core/transport';
import { SttResource } from '../stt';
import { ASR_RUNTIME_DEGRADED_REASONS, isSttDegradedStatus } from '../../types/stt';
import type { AsrSessionWarning, StreamSessionResponse } from '../../types/stt';

const WARNING: AsrSessionWarning = {
  code: 'DIARIZATION_MODEL_MISSING',
  stage: 'diarization',
  severity: 'WARNING',
  message: 'Speaker diarization is off for this session: no speaker-embedding model.',
  agentSlug: 'sarvam-diarization',
};

describe('SttResource#createStreamSession — warnings (TASK-1048)', () => {
  it('returns the warnings the gateway attached to the session', async () => {
    const body = {
      sessionId: 's1',
      status: 'active',
      wsUrl: '/ws/stt/stream',
      maxConcurrent: 5,
      currentActive: 1,
      ticket: 't',
      ticketExpiresAt: 1,
      sessionEpochMs: 1,
      warnings: [WARNING],
    };
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const stt = new SttResource(new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl }));

    const session: StreamSessionResponse = await stt.createStreamSession({ agentSlug: 'sarvam-diarization' });

    expect(session.warnings).toEqual([WARNING]);
    expect(session.warnings?.[0]?.stage).toBe('diarization');
  });
});

describe('isSttDegradedStatus (TASK-1048)', () => {
  it('recognises a degraded frame and narrows its reason', () => {
    const frame = { type: 'status' as const, status: 'degraded', reason: 'diarization_unavailable', message: 'x' };
    expect(isSttDegradedStatus(frame)).toBe(true);
    expect(ASR_RUNTIME_DEGRADED_REASONS).toContain('diarization_unavailable');
  });

  it('rejects other statuses and a degraded frame with no reason', () => {
    expect(isSttDegradedStatus({ type: 'status', status: 'provider_switched', reason: 'auto' })).toBe(false);
    expect(isSttDegradedStatus({ type: 'status', status: 'degraded' })).toBe(false);
  });
});
