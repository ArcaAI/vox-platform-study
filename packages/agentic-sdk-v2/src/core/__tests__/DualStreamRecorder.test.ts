/**
 * DualStreamRecorder Tests (TASK-329 P2 — dual-capture X8)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DualStreamRecorder } from '../DualStreamRecorder';

class FakeMediaRecorder {
  static isTypeSupported = vi.fn().mockReturnValue(true);
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: any, public options?: { mimeType?: string }) {}
  start(_timeslice?: number): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['chunk'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

class FakeMediaStream {
  constructor(public tracks: any[] = []) {}
}

const fakeTrack = (id: string) => ({ id, kind: 'audio', stop: vi.fn() }) as unknown as MediaStreamTrack;

describe('DualStreamRecorder (TASK-329 P2)', () => {
  beforeEach(() => {
    FakeMediaRecorder.isTypeSupported.mockReturnValue(true);
    (globalThis as any).MediaRecorder = FakeMediaRecorder;
    (globalThis as any).MediaStream = FakeMediaStream;
  });

  it('records raw + processed tracks and yields two blobs on stop', async () => {
    const rec = new DualStreamRecorder(fakeTrack('raw'), fakeTrack('proc'), { mimeType: 'audio/webm' });
    expect(rec.isRecording).toBe(false);

    rec.start();
    expect(rec.isRecording).toBe(true);

    const result = await rec.stop();
    expect(result.raw).toBeInstanceOf(Blob);
    expect(result.processed).toBeInstanceOf(Blob);
    expect(result.raw.size).toBeGreaterThan(0);
    expect(result.processed.size).toBeGreaterThan(0);
    expect(rec.isRecording).toBe(false);
  });

  it('start() is idempotent while already running', () => {
    const rec = new DualStreamRecorder(fakeTrack('raw'), fakeTrack('proc'));
    rec.start();
    expect(() => rec.start()).not.toThrow();
    expect(rec.isRecording).toBe(true);
  });

  it('stop() rejects when not running', async () => {
    const rec = new DualStreamRecorder(fakeTrack('raw'), fakeTrack('proc'));
    await expect(rec.stop()).rejects.toThrow('not running');
  });

  it('constructs without a mimeType when the codec is unsupported', () => {
    FakeMediaRecorder.isTypeSupported.mockReturnValue(false);
    const rec = new DualStreamRecorder(fakeTrack('raw'), fakeTrack('proc'), { mimeType: 'audio/x-unsupported' });
    expect(() => rec.start()).not.toThrow();
  });
});
