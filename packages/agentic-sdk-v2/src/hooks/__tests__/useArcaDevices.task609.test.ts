/**
 * useArcaDevices — runtime audio-input discovery.
 *
 * Every integrator that lets a clinician pick a microphone was rebuilding the
 * same three-part dance, and getting it wrong in the same three ways:
 *
 *  1. `enumerateDevices()` before permission returns entries with EMPTY labels —
 *     unusable in a picker, and indistinguishable from "no devices".
 *  2. Nothing in the SDK listened for `devicechange`, so a microphone plugged in
 *     after the picker rendered never appeared.
 *  3. `deviceId` is NOT stable — it rotates per origin/permission state. An app
 *     that persists the id alone gets `OverconstrainedError` on the next visit;
 *     the durable identity is (label, groupId).
 *
 * Deliberately provider-free: a device picker must be able to render before any
 * SDK session exists, so this hook touches neither the store nor the client.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useArcaDevices } from '../useArcaDevices';

function device(deviceId: string, label: string, groupId = `group-${deviceId}`): MediaDeviceInfo {
  return { deviceId, label, groupId, kind: 'audioinput', toJSON: () => ({}) } as MediaDeviceInfo;
}

let listeners: Record<string, (() => void)[]>;
let enumerateDevices: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;

function stubMediaDevices(initial: MediaDeviceInfo[]) {
  listeners = {};
  enumerateDevices = vi.fn(async () => initial);
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices,
      getUserMedia,
      addEventListener: vi.fn((type: string, fn: () => void) => {
        (listeners[type] ??= []).push(fn);
      }),
      removeEventListener: vi.fn((type: string, fn: () => void) => {
        listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn);
      }),
    },
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('useArcaDevices', () => {
  it('lists audio inputs only, dropping outputs and cameras', async () => {
    stubMediaDevices([
      device('mic-1', 'Built-in Microphone'),
      { ...device('spk-1', 'Speakers'), kind: 'audiooutput' } as MediaDeviceInfo,
      { ...device('cam-1', 'FaceTime HD'), kind: 'videoinput' } as MediaDeviceInfo,
    ]);

    const { result } = renderHook(() => useArcaDevices());

    await waitFor(() => expect(result.current.devices).toHaveLength(1));
    expect(result.current.devices[0]).toMatchObject({ deviceId: 'mic-1', label: 'Built-in Microphone' });
  });

  it('reports permission as `prompt` while labels are blank, and `granted` once they are not', async () => {
    stubMediaDevices([device('mic-1', '')]);
    const { result } = renderHook(() => useArcaDevices());

    await waitFor(() => expect(result.current.permission).toBe('prompt'));

    enumerateDevices.mockResolvedValue([device('mic-1', 'USB Mic Array')]);
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.permission).toBe('granted');
  });

  it('requestPermission opens then immediately releases a stream, and re-enumerates for labels', async () => {
    stubMediaDevices([device('mic-1', '')]);
    const stopped = vi.fn();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopped }] });

    const { result } = renderHook(() => useArcaDevices());
    await waitFor(() => expect(result.current.permission).toBe('prompt'));

    enumerateDevices.mockResolvedValue([device('mic-1', 'USB Mic Array')]);
    let granted = false;
    await act(async () => {
      granted = await result.current.requestPermission();
    });

    expect(granted).toBe(true);
    // The probe must not hold the microphone open — the recording indicator
    // would stay lit for the whole time the picker is on screen.
    expect(stopped).toHaveBeenCalled();
    expect(result.current.devices[0].label).toBe('USB Mic Array');
  });

  it('reports `denied` when the user refuses, without throwing', async () => {
    stubMediaDevices([device('mic-1', '')]);
    getUserMedia.mockRejectedValue(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));

    const { result } = renderHook(() => useArcaDevices());
    let granted = true;
    await act(async () => {
      granted = await result.current.requestPermission();
    });

    expect(granted).toBe(false);
    expect(result.current.permission).toBe('denied');
  });

  it('picks up a microphone connected at RUNTIME via devicechange', async () => {
    stubMediaDevices([device('mic-1', 'Built-in Microphone')]);
    const { result } = renderHook(() => useArcaDevices());
    await waitFor(() => expect(result.current.devices).toHaveLength(1));

    enumerateDevices.mockResolvedValue([device('mic-1', 'Built-in Microphone'), device('mic-2', 'USB Mic Array')]);
    await act(async () => {
      listeners['devicechange']?.forEach((fn) => fn());
    });

    await waitFor(() => expect(result.current.devices).toHaveLength(2));
  });

  it('unsubscribes from devicechange on unmount', async () => {
    stubMediaDevices([device('mic-1', 'Built-in Microphone')]);
    const { unmount } = renderHook(() => useArcaDevices());
    await waitFor(() => expect(listeners['devicechange']).toHaveLength(1));

    unmount();
    expect(listeners['devicechange']).toHaveLength(0);
  });

  describe('resolveDeviceId — the id is not the identity', () => {
    beforeEach(() => stubMediaDevices([device('id-A', 'USB Mic Array', 'group-1'), device('id-B', 'Built-in Microphone', 'group-2')]));

    it('prefers a still-valid deviceId', async () => {
      const { result } = renderHook(() => useArcaDevices());
      await waitFor(() => expect(result.current.devices).toHaveLength(2));

      expect(result.current.resolveDeviceId({ deviceId: 'id-B' })).toBe('id-B');
    });

    it('recovers the device by (label, groupId) when the persisted id has rotated', async () => {
      const { result } = renderHook(() => useArcaDevices());
      await waitFor(() => expect(result.current.devices).toHaveLength(2));

      expect(result.current.resolveDeviceId({ deviceId: 'stale-id', label: 'USB Mic Array', groupId: 'group-1' })).toBe('id-A');
    });

    it('falls back to the label alone when the groupId has rotated too', async () => {
      const { result } = renderHook(() => useArcaDevices());
      await waitFor(() => expect(result.current.devices).toHaveLength(2));

      expect(result.current.resolveDeviceId({ deviceId: 'stale', label: 'USB Mic Array', groupId: 'stale-group' })).toBe('id-A');
    });

    it('returns undefined for a device that is genuinely gone — never a wrong guess', async () => {
      const { result } = renderHook(() => useArcaDevices());
      await waitFor(() => expect(result.current.devices).toHaveLength(2));

      expect(result.current.resolveDeviceId({ deviceId: 'gone', label: 'Unplugged Headset', groupId: 'g' })).toBeUndefined();
    });
  });

  it('degrades honestly on a runtime without mediaDevices', async () => {
    vi.stubGlobal('navigator', {});
    const { result } = renderHook(() => useArcaDevices());

    expect(result.current.isSupported).toBe(false);
    expect(result.current.devices).toEqual([]);
    await expect(result.current.refresh()).resolves.toBeUndefined();
  });
});
