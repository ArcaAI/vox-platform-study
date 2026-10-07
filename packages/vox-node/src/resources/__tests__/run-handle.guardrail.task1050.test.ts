/**
 * TASK-1050 W2d — guardrail notices and `run.paused` on the protocol-v2 run handle: `onGuardrailNotice` fires once per
 * notice id, `run.paused` is never terminal (the run goes on to complete), and the handle keeps the notices.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HopeClient } from '../../client';
import type { RunGuardrailNotice } from '../../core/run-protocol';

const BASE = 'http://localhost:8868';
const WF = '/api/v1/workflows/note-writer/runs';
const TS = '2026-10-07T09:15:00.000Z';
const OVERLAY = JSON.parse(readFileSync(resolve(__dirname, '../../../../../tests/contracts/guardrail-run-events.fixture.json'), 'utf8')) as {
  notices: RunGuardrailNotice[];
};
const [WARNING, BLOCKED] = OVERLAY.notices as [RunGuardrailNotice, RunGuardrailNotice];

function v2(seq: number, type: string, data: Record<string, unknown>, nodeId?: string): string {
  const envelope = { seq, runId: 'run-1', type, ts: TS, ...(nodeId === undefined ? {} : { nodeId }), data };
  return `event: ${type}\nid: ${seq}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function sse(frames: string[]): Response {
  return new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** The first connection delivers `frames`; any reconnect fails like a reset socket (a real gateway would hold it open). */
function handle(frames: string[]) {
  let connections = 0;
  const fetchImpl = vi.fn(async () => {
    connections += 1;
    if (connections > 1) throw new TypeError('fetch failed');
    return sse(frames);
  }) as unknown as typeof fetch;
  const client = new HopeClient({ baseUrl: BASE, apiKey: 'k', fetch: fetchImpl, maxRetries: 0 });
  return { run: client.workflows.attach('note-writer', 'run-1', { reconnectDelayMs: 0, maxReconnects: 0 }), fetchImpl };
}

const completed = (seq: number, extra: Record<string, unknown> = {}): string =>
  v2(seq, 'run.completed', { status: 'COMPLETED', durationMs: 5, tokens: { in: 1, out: 2 }, ...extra });

describe('RunHandle — guardrail notices', () => {
  it('calls onGuardrailNotice once per notice id and yields the notice events', async () => {
    const { run } = handle([
      v2(1, 'run.started', { kind: 'workflow', slug: 'note-writer', versionNumber: 1 }),
      v2(2, 'guardrail.notice', WARNING as never, 'n_note'),
      completed(3, { guardrailNotices: [WARNING] }),
    ]);
    const seen: string[] = [];
    const types: string[] = [];
    for await (const event of run.events({ onGuardrailNotice: (n) => seen.push(n.noticeId) })) types.push(event.type);

    expect(seen).toEqual([WARNING.noticeId]);
    expect(types).toEqual(['run.started', 'guardrail.notice', 'run.completed']);
    expect(run.guardrailNotices.map((n) => n.noticeId)).toEqual([WARNING.noticeId]);
    expect(run.outcome?.guardrailNotices?.[0]?.noticeId).toBe(WARNING.noticeId);
  });

  it('announces a notice that only run.completed carries', async () => {
    const { run } = handle([completed(1, { guardrailNotices: [WARNING] })]);
    const seen: string[] = [];
    await run.wait({ onGuardrailNotice: (n) => seen.push(n.type) });
    expect(seen).toEqual(['guardrail.warning']);
    expect(run.guardrailNotices).toHaveLength(1);
  });

  it('a run with no notices has none and the outcome omits the field', async () => {
    const { run } = handle([completed(1)]);
    const outcome = await run.wait();
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.guardrailNotices).toBeUndefined();
    expect(run.guardrailNotices).toEqual([]);
  });
});

describe('RunHandle — run.paused is not terminal', () => {
  const paused = (seq: number): string => v2(seq, 'run.paused', { reason: 'guardrail_hold', noticeId: BLOCKED.noticeId, nodeId: 'n_note' });

  it('keeps following through run.paused to the real terminal event', async () => {
    const { run } = handle([
      v2(1, 'guardrail.notice', BLOCKED as never, 'n_note'),
      paused(2),
      v2(3, 'node.started', { kind: 'core.agent' }, 'n_note'),
      completed(4),
    ]);
    const types: string[] = [];
    for await (const event of run.events()) types.push(event.type);
    expect(types).toEqual(['guardrail.notice', 'run.paused', 'node.started', 'run.completed']);
    expect(run.status).toBe('COMPLETED');
    expect(run.paused).toBeUndefined();
  });

  it('exposes the pause while the run waits: a dropped stream interrupts the view, it does not settle the run', async () => {
    // The connection closes after run.paused while the run is still waiting at the hold.
    const { run } = handle([paused(1)]);
    const types: string[] = [];
    await expect(
      (async () => {
        for await (const event of run.events({ autoResume: false })) types.push(event.type);
      })(),
    ).rejects.toMatchObject({ name: 'RunStreamInterruptedError' });
    expect(types).toEqual(['run.paused']);
    expect(run.paused).toEqual({ noticeId: BLOCKED.noticeId, nodeId: 'n_note', reason: 'guardrail_hold' });
    expect(run.outcome).toBeUndefined();
    expect(run.status).toBe('RUNNING');
  });
});
