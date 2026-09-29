/**
 * TASK-1019 P5 (throttle half) — `DownloadHeartbeat` writes progress + liveness
 * at most once per interval, however often bytes arrive, and never runs two
 * writes at once.
 */
import { describe, expect, it, vi } from 'vitest';
import { DownloadHeartbeat } from '../download-heartbeat';

function clock(start = Date.parse('2026-09-29T10:00:00.000Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('DownloadHeartbeat (P5)', () => {
  it('writes bytesDone at most once per interval, however many chunks arrive', async () => {
    const c = clock();
    const write = vi.fn().mockResolvedValue(undefined);
    const hb = new DownloadHeartbeat(write, { intervalMs: 5000, now: c.now });

    hb.setTotal(1000);
    for (let i = 0; i < 100; i++) {
      hb.addBytes(5);
      c.advance(40); // 100 chunks over 4 s
    }
    await hb.stop();
    expect(write).toHaveBeenCalledTimes(1);

    c.advance(1000); // now 5 s after the first write
    hb.addBytes(10);
    await hb.stop();

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toEqual({ bytesDone: 510, bytesTotal: 1000, heartbeatAt: new Date(c.now()).toISOString() });
  });

  it('beat() refreshes liveness without new bytes (the upload phase), under the same throttle', async () => {
    const c = clock();
    const write = vi.fn().mockResolvedValue(undefined);
    const hb = new DownloadHeartbeat(write, { intervalMs: 5000, now: c.now });

    hb.beat();
    hb.beat();
    await new Promise((resolve) => setImmediate(resolve)); // let the first write settle
    c.advance(5000);
    hb.beat();
    await hb.stop();

    expect(write).toHaveBeenCalledTimes(2);
  });

  it('never overlaps writes, and a failed write does not fail the job', async () => {
    const c = clock();
    let release!: () => void;
    const write = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
      .mockRejectedValueOnce(new Error('db blip'));
    const onError = vi.fn();
    const hb = new DownloadHeartbeat(write, { intervalMs: 1000, now: c.now, onError });

    hb.beat();
    c.advance(5000);
    hb.beat(); // first write still in flight — skipped
    expect(write).toHaveBeenCalledTimes(1);
    release();
    await hb.stop();

    c.advance(5000);
    hb.beat();
    await expect(hb.stop()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'db blip' }));
  });

  it('start() beats on a timer so a long single-part transfer stays alive; stop() clears it', async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn().mockResolvedValue(undefined);
      const hb = new DownloadHeartbeat(write, { intervalMs: 5000, now: () => Date.now() });
      hb.start();
      await vi.advanceTimersByTimeAsync(15_000);
      await hb.stop();
      const calls = write.mock.calls.length;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(write.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
