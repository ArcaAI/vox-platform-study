import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FinalNoteTimeoutError, FinalNoteUnavailableError } from '../../core/errors';
import { Transport } from '../../core/transport';
import { ConsultationsResource } from '../consultations';

const BASE = 'http://localhost:8868/api/v1/consultations/c1';
const STOPPED_AT = '2026-09-29T12:00:00.000Z';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function note(updatedAt: string, id = 's1') {
  return { id, consultationId: 'c1', type: 'summary', content: 'note', createdAt: '2026-09-29T08:00:00.000Z', updatedAt };
}

function consultation(status: string) {
  return { id: 'c1', patientId: 'p1', doctorId: 'd1', appointmentDate: '2026-09-29', status, createdAt: '', updatedAt: '', governingRun: null };
}

/** A scripted gateway: poll N of each route reads step N; the last step repeats. */
function scripted(steps: Array<{ latest: unknown | 404; status: string }>) {
  let latestPolls = 0;
  let getPolls = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === `${BASE}/summary/latest`) {
      const step = steps[Math.min(latestPolls++, steps.length - 1)]!;
      return step.latest === 404 ? json(404, { message: 'none' }) : json(200, step.latest);
    }
    if (url === BASE) {
      const step = steps[Math.min(getPolls++, steps.length - 1)]!;
      return json(200, consultation(step.status));
    }
    throw new Error(`unexpected ${url}`);
  });
  const resource = new ConsultationsResource(new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl }));
  return { resource, fetchImpl };
}

describe('ConsultationsResource#waitForFinalNote', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T12:00:10.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('ignores a note older than `since`, then resolves when a fresh one lands', async () => {
    const stale = note('2026-09-29T08:30:00.000Z', 'morning');
    const fresh = note('2026-09-29T12:01:00.000Z', 'afternoon');
    const { resource } = scripted([
      { latest: stale, status: 'DRAINING' },
      { latest: stale, status: 'PENDING_REVIEW' }, // status is ready but the note is still the morning's
      { latest: fresh, status: 'PENDING_REVIEW' },
    ]);

    const settled = vi.fn();
    const p = resource.waitForFinalNote('c1', { since: new Date(STOPPED_AT), pollIntervalMs: 1000 });
    void p.then(settled);

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ id: 'afternoon' });
  });

  it('accepts `since` as an ISO string and falls back to createdAt when updatedAt is absent', async () => {
    const fresh = { id: 's2', consultationId: 'c1', type: 'summary', content: 'n', createdAt: '2026-09-29T12:05:00.000Z' };
    const { resource } = scripted([{ latest: fresh, status: 'SIGNED' }]);
    await expect(resource.waitForFinalNote('c1', { since: STOPPED_AT })).resolves.toMatchObject({ id: 's2' });
  });

  it('does not resolve on a fresh note until the status is a note-ready one', async () => {
    const fresh = note('2026-09-29T12:01:00.000Z');
    const { resource } = scripted([
      { latest: fresh, status: 'DRAINING' },
      { latest: fresh, status: 'DRAFT_PENDING_SENSORS' },
    ]);
    const p = resource.waitForFinalNote('c1', { since: STOPPED_AT, pollIntervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ id: 's1' });
  });

  it('treats a 404 from summary/latest as "not yet"', async () => {
    const fresh = note('2026-09-29T12:01:00.000Z');
    const { resource } = scripted([
      { latest: 404, status: 'DRAINING' },
      { latest: fresh, status: 'TIMED_OUT' },
    ]);
    const p = resource.waitForFinalNote('c1', { since: STOPPED_AT, pollIntervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ id: 's1' });
  });

  it('rejects with FinalNoteUnavailableError when the consultation closes incomplete with no fresh note', async () => {
    const stale = note('2026-09-29T08:30:00.000Z');
    const { resource } = scripted([{ latest: stale, status: 'CLOSED_INCOMPLETE' }]);
    const err = await resource.waitForFinalNote('c1', { since: STOPPED_AT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinalNoteUnavailableError);
    expect((err as FinalNoteUnavailableError).status).toBe('CLOSED_INCOMPLETE');
    expect((err as FinalNoteUnavailableError).consultationId).toBe('c1');
  });

  it('rejects with FinalNoteTimeoutError when no fresh note arrives within timeoutMs', async () => {
    const stale = note('2026-09-29T08:30:00.000Z');
    const { resource } = scripted([{ latest: stale, status: 'DRAINING' }]);
    const p = resource.waitForFinalNote('c1', { since: STOPPED_AT, timeoutMs: 5000, pollIntervalMs: 2000 });
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(6000);
    const err = await caught;
    expect(err).toBeInstanceOf(FinalNoteTimeoutError);
    expect((err as FinalNoteTimeoutError).timeoutMs).toBe(5000);
  });

  it('honours an AbortSignal between polls', async () => {
    const stale = note('2026-09-29T08:30:00.000Z');
    const { resource, fetchImpl } = scripted([{ latest: stale, status: 'DRAINING' }]);
    const ac = new AbortController();
    const p = resource.waitForFinalNote('c1', { since: STOPPED_AT, pollIntervalMs: 5000, signal: ac.signal });
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    const callsBefore = fetchImpl.mock.calls.length;
    ac.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await caught;
    expect((err as Error).name).toBe('AbortError');
    expect(fetchImpl.mock.calls.length).toBe(callsBefore);
  });

  it('rejects an unparseable `since` locally', async () => {
    const { resource } = scripted([{ latest: 404, status: 'OPEN' }]);
    await expect(resource.waitForFinalNote('c1', { since: 'not-a-date' })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('ConsultationsResource#chain', () => {
  it('GETs /consultations/:id/chain', async () => {
    const rows = [consultation('SIGNED'), consultation('OPEN')];
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, rows));
    const resource = new ConsultationsResource(new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl }));
    const result = await resource.chain('c/1');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/c%2F1/chain');
    expect(result).toEqual(rows);
  });
});
