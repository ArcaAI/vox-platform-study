import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudioSources } from '../use-audio-sources';

/**
 * `useAudioSources` — the mode → `audio.start(...)` option mapping.
 *
 * This is the load-bearing part of lane A on the app side: whatever `sources`
 * shows must be exactly what the SDK is asked to capture, in the same order.
 */

const decodeGroup = vi.hoisted(() => ({
  dispose: vi.fn(),
  sources: [
    { id: 'file-1', label: 'a.wav', stream: { id: 's1' }, duration: 6 },
    { id: 'file-2', label: 'b.wav', stream: { id: 's2' }, duration: 9 },
  ],
  duration: 9,
  currentTime: 0,
  isPlaying: false,
  play: vi.fn(async () => {}),
  pause: vi.fn(),
  seek: vi.fn(),
  setLoop: vi.fn(),
  setPlaybackRate: vi.fn(),
}));
const createGroup = vi.hoisted(() => vi.fn(async () => decodeGroup));

vi.mock('../../lib/file-audio-source', () => ({
  FileAudioSourceGroup: { create: createGroup },
  FileAudioSourceError: class extends Error {},
}));

function device(deviceId: string, label: string): MediaDeviceInfo {
  return { deviceId, label, kind: 'audioinput', groupId: 'g' } as MediaDeviceInfo;
}

let devices: MediaDeviceInfo[] = [];
const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));

beforeEach(() => {
  vi.clearAllMocks();
  devices = [device('mic-a', 'Built-in'), device('mic-b', 'USB headset'), device('mic-c', 'Interface')];
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: vi.fn(async () => devices),
      getUserMedia,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mount() {
  const rendered = renderHook(() => useAudioSources());
  await waitFor(() => expect(rendered.result.current.devices).toHaveLength(3));
  return rendered;
}

describe('useAudioSources — device enumeration', () => {
  it('lists only audioinput devices and reports granted permission when labels are readable', async () => {
    const { result } = await mount();
    expect(result.current.permissionStatus).toBe('granted');
  });

  it('reports `prompt` while device labels are still blank', async () => {
    devices = [device('mic-a', ''), device('mic-b', '')];
    const { result } = renderHook(() => useAudioSources());
    await waitFor(() => expect(result.current.devices).toHaveLength(2));
    expect(result.current.permissionStatus).toBe('prompt');
  });

  it('requestPermission opens a mic and immediately releases it', async () => {
    const stop = vi.fn();
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [{ stop }] });
    const { result } = await mount();

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    // Leaving it open would light the recording indicator with nothing recording.
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('useAudioSources — mic modes', () => {
  it('single-mic yields one source and a bare deviceId', async () => {
    const { result } = await mount();

    act(() => result.current.selectDevice('mic-b'));

    expect(result.current.sources).toEqual([{ id: 'mic-b', micLabel: 'mic 1', sourceLabel: 'USB headset', gain: 1 }]);
    expect(result.current.captureOptions).toEqual({ deviceId: 'mic-b' });
  });

  it('multi-mic maps SELECTION ORDER onto deviceId → secondaryDeviceId → additionalDeviceIds', async () => {
    const { result } = await mount();

    act(() => result.current.setMode('multi-mic'));
    act(() => result.current.toggleDevice('mic-c'));
    act(() => result.current.toggleDevice('mic-a'));
    act(() => result.current.toggleDevice('mic-b'));

    expect(result.current.sources.map((s) => [s.micLabel, s.id])).toEqual([
      ['mic 1', 'mic-c'],
      ['mic 2', 'mic-a'],
      ['mic 3', 'mic-b'],
    ]);
    expect(result.current.captureOptions).toEqual({
      deviceId: 'mic-c',
      secondaryDeviceId: 'mic-a',
      additionalDeviceIds: ['mic-b'],
    });
  });

  it('toggling a device off re-numbers the remaining mics', async () => {
    const { result } = await mount();

    act(() => result.current.setMode('multi-mic'));
    act(() => result.current.toggleDevice('mic-a'));
    act(() => result.current.toggleDevice('mic-b'));
    act(() => result.current.toggleDevice('mic-a'));

    expect(result.current.sources.map((s) => [s.micLabel, s.id])).toEqual([['mic 1', 'mic-b']]);
  });

  it('narrowing multi → single keeps only the first pick', async () => {
    const { result } = await mount();

    act(() => result.current.setMode('multi-mic'));
    act(() => result.current.toggleDevice('mic-a'));
    act(() => result.current.toggleDevice('mic-b'));
    act(() => result.current.setMode('single-mic'));

    expect(result.current.captureOptions).toEqual({ deviceId: 'mic-a' });
  });

  it('selecting nothing sends NO source options (the SDK opens the default mic)', async () => {
    const { result } = await mount();
    expect(result.current.captureOptions).toEqual({});
  });

  it('forwards sourceGains only when a gain is off unity', async () => {
    const { result } = await mount();

    act(() => result.current.setMode('multi-mic'));
    act(() => result.current.toggleDevice('mic-a'));
    act(() => result.current.toggleDevice('mic-b'));
    expect(result.current.captureOptions.sourceGains).toBeUndefined();

    act(() => result.current.setGain('mic-b', 0.5));
    expect(result.current.captureOptions.sourceGains).toEqual([1, 0.5]);
  });
});

describe('useAudioSources — file modes', () => {
  it('file-single decodes only the first file and passes ONE stream', async () => {
    createGroup.mockResolvedValueOnce({ ...decodeGroup, sources: [decodeGroup.sources[0]], duration: 6 } as never);
    const { result } = await mount();

    act(() => result.current.setMode('file-single'));
    await act(async () => {
      await result.current.loadFiles([{ name: 'a.wav' } as File, { name: 'b.wav' } as File]);
    });

    expect(createGroup).toHaveBeenCalledWith([{ file: expect.objectContaining({ name: 'a.wav' }), splitStereo: false }]);
    expect(result.current.captureOptions.sourceStreams).toHaveLength(1);
    // The mic path is untouched: no deviceId leaks into a file run.
    expect(result.current.captureOptions.deviceId).toBeUndefined();
  });

  it('file-multi passes every decoded stream in order and labels them as mics', async () => {
    const { result } = await mount();

    act(() => result.current.setMode('file-multi'));
    await act(async () => {
      await result.current.loadFiles([{ name: 'a.wav' } as File, { name: 'b.wav' } as File]);
    });

    expect(result.current.sources.map((s) => [s.micLabel, s.sourceLabel])).toEqual([
      ['mic 1', 'a.wav'],
      ['mic 2', 'b.wav'],
    ]);
    expect(result.current.captureOptions.sourceStreams).toHaveLength(2);
  });

  it('passes splitStereo through in file-multi only', async () => {
    const { result } = await mount();

    act(() => result.current.setMode('file-multi'));
    act(() => result.current.setSplitStereo(true));
    await act(async () => {
      await result.current.loadFiles([{ name: 'stereo.wav' } as File]);
    });

    expect(createGroup).toHaveBeenCalledWith([expect.objectContaining({ splitStereo: true })]);
  });

  it('surfaces a decode failure as fileError and keeps the options empty', async () => {
    createGroup.mockRejectedValueOnce(new Error('Could not decode "broken.bin"'));
    const { result } = await mount();

    act(() => result.current.setMode('file-single'));
    await act(async () => {
      await result.current.loadFiles([{ name: 'broken.bin' } as File]);
    });

    expect(result.current.fileError).toMatch(/broken\.bin/);
    expect(result.current.captureOptions).toEqual({});
  });

  it('clearFiles disposes the decoded group and empties the sources', async () => {
    const { result } = await mount();

    act(() => result.current.setMode('file-multi'));
    await act(async () => {
      await result.current.loadFiles([{ name: 'a.wav' } as File]);
    });
    act(() => result.current.clearFiles());

    expect(decodeGroup.dispose).toHaveBeenCalled();
    expect(result.current.sources).toEqual([]);
  });

  it('unmounting disposes the decoded group (no orphaned AudioContext or stream)', async () => {
    const rendered = await mount();

    act(() => rendered.result.current.setMode('file-multi'));
    await act(async () => {
      await rendered.result.current.loadFiles([{ name: 'a.wav' } as File]);
    });
    rendered.unmount();

    expect(decodeGroup.dispose).toHaveBeenCalled();
  });

  it('forwards transport actions to the decoded group', async () => {
    const { result } = await mount();

    act(() => result.current.setMode('file-multi'));
    await act(async () => {
      await result.current.loadFiles([{ name: 'a.wav' } as File]);
    });

    await act(async () => result.current.play());
    expect(decodeGroup.play).toHaveBeenCalled();
    act(() => result.current.seek(3));
    expect(decodeGroup.seek).toHaveBeenCalledWith(3);
    act(() => result.current.setLoop(true));
    expect(decodeGroup.setLoop).toHaveBeenCalledWith(true);
    act(() => result.current.setRate(1.5));
    expect(decodeGroup.setPlaybackRate).toHaveBeenCalledWith(1.5);
    expect(result.current.playback.rate).toBe(1.5);
  });
});
