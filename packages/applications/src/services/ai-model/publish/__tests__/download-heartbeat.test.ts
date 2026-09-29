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

  describe('the timer beats only while the job is making progress (I7)', () => {
    async function withFakeTimers(run: () => Promise<void>) {
      vi.useFakeTimers();
      try {
        await run();
      } finally {
        vi.useRealTimers();
      }
    }

    it('a hung transfer — no bytes, nothing in flight — stops refreshing liveness, so the row goes STALLED', async () => {
      await withFakeTimers(async () => {
        const write = vi.fn().mockResolvedValue(undefined);
        const hb = new DownloadHeartbeat(write, { intervalMs: 5000, now: () => Date.now() });
        hb.start();
        hb.addBytes(10); // first write
        await vi.advanceTimersByTimeAsync(60_000);
        await hb.stop();
        expect(write).toHaveBeenCalledTimes(1);
      });
    });

    it('bytes that arrived since the last write are flushed by the next beat, once', async () => {
      await withFakeTimers(async () => {
        const write = vi.fn().mockResolvedValue(undefined);
        const hb = new DownloadHeartbeat(write, { intervalMs: 5000, now: () => Date.now() });
        hb.start();
        hb.addBytes(10); // written
        await vi.advanceTimersByTimeAsync(1000);
        hb.addBytes(10); // throttled — not written yet
        await vi.advanceTimersByTimeAsync(30_000);
        await hb.stop();
        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls[1][0]).toMatchObject({ bytesDone: 20 });
      });
    });

    it('keeps beating while an upload request is in flight (bounded by the store request timeout), and stops once it settles', async () => {
      await withFakeTimers(async () => {
        const write = vi.fn().mockResolvedValue(undefined);
        const hb = new DownloadHeartbeat(write, { intervalMs: 5000, now: () => Date.now() });
        hb.start();
        let finish!: () => void;
        const upload = hb.during(new Promise<void>((resolve) => (finish = resolve)));
        await vi.advanceTimersByTimeAsync(15_000);
        expect(write.mock.calls.length).toBeGreaterThanOrEqual(3);
        finish();
        await upload;
        const settled = write.mock.calls.length;
        await vi.advanceTimersByTimeAsync(30_000);
        await hb.stop();
        expect(write.mock.calls.length).toBeLessThanOrEqual(settled + 1);
      });
    });

    it('during() passes the result and the rejection through unchanged', async () => {
      const hb = new DownloadHeartbeat(vi.fn().mockResolvedValue(undefined), { intervalMs: 5000 });
      await expect(hb.during(Promise.resolve(42))).resolves.toBe(42);
      await expect(hb.during(Promise.reject(new Error('put failed')))).rejects.toThrow('put failed');
    });

    it('stop() clears the timer', async () => {
      await withFakeTimers(async () => {
        const write = vi.fn().mockResolvedValue(undefined);
        const hb = new DownloadHeartbeat(write, { intervalMs: 5000, now: () => Date.now() });
        hb.start();
        void hb.during(new Promise(() => undefined));
        await vi.advanceTimersByTimeAsync(10_000);
        await hb.stop();
        const calls = write.mock.calls.length;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(write.mock.calls.length).toBe(calls);
      });
    });
  });
});
