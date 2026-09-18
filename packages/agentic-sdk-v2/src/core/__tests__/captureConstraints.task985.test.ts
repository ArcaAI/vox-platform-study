/**
 * TASK-985 M-33 / OD-L — the governed browser capture switches.
 *
 * AEC / noise suppression / AGC were declared in `AudioConfigSchema`,
 * permission-tagged `permission: 'user'` in `CONFIG_PERMISSIONS`, resolved
 * through the tenant → user cascade into `AppConfig.audio`, and read by nobody.
 * A tenant admin could set them and capture would ignore it; the only thing
 * that ever reached `getUserMedia` was the ungoverned per-call override.
 *
 * These tests pin the wiring AND the promise that comes with it: shipped
 * behaviour is unchanged. Whether the governed default should be NS/AGC OFF is
 * OD-L, unanswered, and not this change's to decide.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';

import { AppConfigSchema } from '../ConfigSchema';
import { applyCaptureConstraints, resolveCaptureConstraints } from '../captureConstraints';

describe('resolveCaptureConstraints (TASK-985 M-33)', () => {
  it('reads the governed values a parsed AppConfig carries — the hop that did not exist', () => {
    const resolved = v.parse(AppConfigSchema, { audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });

    expect(resolveCaptureConstraints(resolved, undefined)).toEqual({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it("keeps today's shipped behaviour: a default-parsed config resolves all three ON, which is also the browser default", () => {
    const resolved = v.parse(AppConfigSchema, {});

    expect(resolveCaptureConstraints(resolved, undefined)).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });

  it('lets a per-call override win over the cascade, per key', () => {
    const resolved = v.parse(AppConfigSchema, { audio: { noiseSuppression: true, autoGainControl: true } });

    expect(resolveCaptureConstraints(resolved, { autoGainControl: false })).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    });
  });

  it('returns an EMPTY object when nothing is governed and nothing was passed', () => {
    // Load-bearing: the caller uses emptiness to decide between
    // `getUserMedia({ audio: true })` and `{ audio: {…} }`, which are
    // materially different requests.
    expect(resolveCaptureConstraints(null, undefined)).toEqual({});
    expect(resolveCaptureConstraints(undefined, undefined)).toEqual({});
  });

  it('ignores non-boolean junk in either source rather than forwarding it to getUserMedia', () => {
    const bogus = { audio: { echoCancellation: 'yes', noiseSuppression: 1 } } as unknown as Parameters<typeof resolveCaptureConstraints>[0];

    expect(resolveCaptureConstraints(bogus, { autoGainControl: undefined })).toEqual({});
  });
});

describe('applyCaptureConstraints (TASK-985 M-33)', () => {
  function fakeTrack(applyConstraints = vi.fn(async () => undefined)) {
    return { applyConstraints } as unknown as MediaStreamTrack & { applyConstraints: ReturnType<typeof vi.fn> };
  }

  it('asserts the constraints on every track — a getUserMedia hint is a request, made once', async () => {
    const a = fakeTrack();
    const b = fakeTrack();

    await applyCaptureConstraints([a, b], { noiseSuppression: false });

    expect(a.applyConstraints).toHaveBeenCalledWith({ noiseSuppression: false });
    expect(b.applyConstraints).toHaveBeenCalledWith({ noiseSuppression: false });
  });

  it('does nothing at all when there is nothing to assert', async () => {
    const track = fakeTrack();
    await applyCaptureConstraints([track], {});
    expect(track.applyConstraints).not.toHaveBeenCalled();
  });

  it('reports a refusal instead of throwing — a device that says no must not end a live consultation', async () => {
    const failing = fakeTrack(
      vi.fn(async () => {
        throw new Error('OverconstrainedError');
      }),
    );
    const onFailure = vi.fn();

    await expect(applyCaptureConstraints([failing], { autoGainControl: false }, onFailure)).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
