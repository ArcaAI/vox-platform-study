/**
 * Browser-side duration probe.
 *
 * The gateway rejects an over-long recording, but doing so costs the user a
 * full upload of a file that was never going to be accepted — for a 60-minute
 * recording that is ~115 MB pushed for nothing. This probe reads the duration
 * locally first, so the queue can refuse it before a byte leaves the browser.
 *
 * The gateway check stays authoritative; this one exists to save the round trip.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeAudioDurationSeconds } from '../audioDuration';

/** Drive whichever listener the implementation registered on the element. */
type FakeAudio = Omit<HTMLAudioElement, 'duration'> & { duration: number; __fire: (event: 'loadedmetadata' | 'error') => void };

let created: FakeAudio[] = [];
let objectUrls: string[] = [];
let revoked: string[] = [];

beforeEach(() => {
  created = [];
  objectUrls = [];
  revoked = [];

  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'audio') return Object.create(HTMLElement.prototype) as HTMLElement;
    const listeners = new Map<string, EventListener>();
    const el = {
      preload: '',
      src: '',
      duration: Number.NaN,
      addEventListener: (type: string, fn: EventListener) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      load: vi.fn(),
      __fire: (event: string) => listeners.get(event)?.(new Event(event)),
    } as unknown as FakeAudio;
    created.push(el);
    return el;
  }) as typeof document.createElement);

  URL.createObjectURL = vi.fn(() => {
    const url = `blob:fake-${objectUrls.length}`;
    objectUrls.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
});

afterEach(() => vi.restoreAllMocks());

const file = () => new File(['audio-bytes'], 'consult.wav', { type: 'audio/wav' });

describe('probeAudioDurationSeconds (browser)', () => {
  it('resolves the duration the media element reports', async () => {
    const pending = probeAudioDurationSeconds(file());
    created[0]!.duration = 3612.5;
    created[0]!.__fire('loadedmetadata');
    await expect(pending).resolves.toBeCloseTo(3612.5, 3);
  });

  it('resolves null when the element cannot decode the file', async () => {
    const pending = probeAudioDurationSeconds(file());
    created[0]!.__fire('error');
    await expect(pending).resolves.toBeNull();
  });

  it('resolves null for a live/streamed container reporting Infinity', async () => {
    // MediaRecorder output routinely reports Infinity until fully seeked —
    // "unknown", not "very long".
    const pending = probeAudioDurationSeconds(file());
    created[0]!.duration = Number.POSITIVE_INFINITY;
    created[0]!.__fire('loadedmetadata');
    await expect(pending).resolves.toBeNull();
  });

  it('resolves null for a zero or NaN duration', async () => {
    for (const value of [0, Number.NaN]) {
      const pending = probeAudioDurationSeconds(file());
      created[created.length - 1]!.duration = value;
      created[created.length - 1]!.__fire('loadedmetadata');
      await expect(pending, String(value)).resolves.toBeNull();
    }
  });

  it('always revokes the object URL — success, failure and timeout alike', async () => {
    const ok = probeAudioDurationSeconds(file());
    created[0]!.duration = 10;
    created[0]!.__fire('loadedmetadata');
    await ok;

    const bad = probeAudioDurationSeconds(file());
    created[1]!.__fire('error');
    await bad;

    expect(revoked).toEqual(objectUrls);
  });

  it('gives up after the timeout instead of hanging the queue forever', async () => {
    vi.useFakeTimers();
    try {
      const pending = probeAudioDurationSeconds(file(), { timeoutMs: 5000 });
      vi.advanceTimersByTime(5001);
      await expect(pending).resolves.toBeNull();
      expect(revoked).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves null (never throws) where the DOM has no audio element at all', async () => {
    // Node/SSR: the SDK must degrade to "unknown" and let the gateway decide.
    vi.spyOn(document, 'createElement').mockImplementation((() => {
      throw new Error('no DOM');
    }) as typeof document.createElement);
    await expect(probeAudioDurationSeconds(file())).resolves.toBeNull();
  });
});
