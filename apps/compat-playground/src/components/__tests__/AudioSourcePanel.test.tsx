import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `AudioSourcePanel` (TASK-597 lane A) — the four capture modes.
 *
 * The session context is stubbed: this suite is about the PANEL's behaviour
 * (permission affordance, mode switching, locking while a session is live,
 * file-playback following the recording lifecycle), not about the SDK.
 */

const session = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('../../context/playground-session', () => ({
  usePlaygroundSession: () => session.value,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AudioSourcePanel } from '../AudioSourcePanel';

function device(deviceId: string, label: string) {
  return { deviceId, label, kind: 'audioinput', groupId: 'g' } as MediaDeviceInfo;
}

type Overrides = { audio?: Record<string, unknown>; capture?: Record<string, unknown> };

function setSession(overrides: Overrides = {}) {
  const audio = {
    mode: 'single-mic',
    setMode: vi.fn(),
    devices: [device('mic-a', 'Built-in'), device('mic-b', 'USB headset')],
    permissionStatus: 'granted',
    refreshDevices: vi.fn(),
    requestPermission: vi.fn().mockResolvedValue(undefined),
    selectedDeviceIds: ['mic-a'],
    selectDevice: vi.fn(),
    toggleDevice: vi.fn(),
    isDecoding: false,
    fileError: null,
    splitStereo: false,
    setSplitStereo: vi.fn(),
    loadFiles: vi.fn().mockResolvedValue(undefined),
    clearFiles: vi.fn(),
    playback: { isPlaying: false, currentTime: 0, duration: 0, loop: false, rate: 1 },
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    setLoop: vi.fn(),
    setRate: vi.fn(),
    sources: [{ id: 'mic-a', micLabel: 'mic 1', sourceLabel: 'Built-in', gain: 1 }],
    setGain: vi.fn(),
    captureOptions: { deviceId: 'mic-a' },
    ...overrides.audio,
  };
  // `phase` is derived exactly the way the provider derives it
  // (`playground-session.tsx`) so a fixture can keep saying `isRecording: true`
  // and still exercise the real gating. Tests that care about the drain window
  // pass `phase: 'stopping'` explicitly — it is the one state that has no
  // `isRecording`/`isStarting` spelling (TASK-597 lane B/G).
  const isRecording = Boolean(overrides.capture?.isRecording);
  const isStarting = Boolean(overrides.capture?.isStarting);
  const capture = {
    isRecording,
    isStarting,
    phase: isStarting ? 'starting' : isRecording ? 'recording' : 'idle',
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides.capture,
  };
  session.value = { audio, capture };
  return { audio, capture };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AudioSourcePanel — modes', () => {
  it('offers exactly the four capture modes', () => {
    setSession();
    render(<AudioSourcePanel />);

    // The accessible name is "<label> <hint>", so anchor on the label.
    [/^One microphone/, /^Multiple microphones/, /^Audio file →/, /^Audio file\(s\) →/].forEach((name) =>
      expect(screen.getByRole('radio', { name })).toBeInTheDocument(),
    );
  });

  it('lists mics as radios in single-mic mode and as checkboxes in multi-mic mode', async () => {
    setSession();
    const { unmount } = render(<AudioSourcePanel />);
    expect(screen.queryByRole('checkbox', { name: /USB headset/i })).not.toBeInTheDocument();
    unmount();

    setSession({ audio: { mode: 'multi-mic', selectedDeviceIds: ['mic-b', 'mic-a'] } });
    render(<AudioSourcePanel />);
    expect(screen.getByRole('checkbox', { name: /USB headset/i })).toBeInTheDocument();
  });

  it('shows the mixer ordinal next to each selected mic in multi-mic mode', () => {
    setSession({
      audio: {
        mode: 'multi-mic',
        selectedDeviceIds: ['mic-b', 'mic-a'],
        sources: [
          { id: 'mic-b', micLabel: 'mic 1', sourceLabel: 'USB headset', gain: 1 },
          { id: 'mic-a', micLabel: 'mic 2', sourceLabel: 'Built-in', gain: 1 },
        ],
      },
    });
    render(<AudioSourcePanel />);

    expect(screen.getByText('Mixer sources (2)')).toBeInTheDocument();
    expect(screen.getByText('mixed into one uplink stream')).toBeInTheDocument();
  });
});

describe('AudioSourcePanel — microphone permission', () => {
  it('shows a Grant affordance (not a device list) while labels are blank', async () => {
    const { audio } = setSession({ audio: { permissionStatus: 'prompt', devices: [device('mic-a', '')] } });
    render(<AudioSourcePanel />);

    const grant = screen.getByRole('button', { name: /grant microphone access/i });
    await userEvent.click(grant);

    expect(audio.requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe('AudioSourcePanel — file modes', () => {
  it('accepts a single file in file-single mode and multiple in file-multi', () => {
    setSession({ audio: { mode: 'file-single', sources: [] } });
    const { unmount } = render(<AudioSourcePanel />);
    expect(screen.getByLabelText('Audio file')).not.toHaveAttribute('multiple');
    unmount();

    setSession({ audio: { mode: 'file-multi', sources: [] } });
    render(<AudioSourcePanel />);
    expect(screen.getByLabelText('Audio files')).toHaveAttribute('multiple');
  });

  it('offers the stereo split only in file-multi mode', () => {
    setSession({ audio: { mode: 'file-single', sources: [] } });
    const { unmount } = render(<AudioSourcePanel />);
    expect(screen.queryByRole('switch', { name: /split a stereo file/i })).not.toBeInTheDocument();
    unmount();

    setSession({ audio: { mode: 'file-multi', sources: [] } });
    render(<AudioSourcePanel />);
    expect(screen.getByRole('switch', { name: /split a stereo file/i })).toBeInTheDocument();
  });

  it('renders the transport (play, seek, loop, rate) once audio is decoded', async () => {
    const { audio } = setSession({
      audio: {
        mode: 'file-single',
        sources: [{ id: 'file-1', micLabel: 'mic 1', sourceLabel: 'consult.wav', gain: 1 }],
        playback: { isPlaying: false, currentTime: 0, duration: 12, loop: false, rate: 1 },
      },
    });
    render(<AudioSourcePanel />);

    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(audio.play).toHaveBeenCalled();

    expect(screen.getByLabelText('Playback position')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Loop' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '2×' }));
    expect(audio.setRate).toHaveBeenCalledWith(2);
  });

  it('starts file playback when recording begins and pauses it when recording ends', () => {
    const base = {
      mode: 'file-single',
      sources: [{ id: 'file-1', micLabel: 'mic 1', sourceLabel: 'consult.wav', gain: 1 }],
      playback: { isPlaying: false, currentTime: 0, duration: 12, loop: false, rate: 1 },
    };
    const { audio } = setSession({ audio: base });
    const { rerender } = render(<AudioSourcePanel />);
    expect(audio.play).not.toHaveBeenCalled();

    // A file source that is not playing feeds SILENCE, which looks exactly like
    // a broken STT session — so the transport follows the record lifecycle.
    setSession({ audio: base, capture: { isRecording: true } });
    rerender(<AudioSourcePanel />);
    expect(session.value).toBeTruthy();
    expect((session.value as { audio: { play: ReturnType<typeof vi.fn> } }).audio.play).toHaveBeenCalledTimes(1);

    const playing = { ...base, playback: { ...base.playback, isPlaying: true } };
    setSession({ audio: playing, capture: { isRecording: false } });
    rerender(<AudioSourcePanel />);
    expect((session.value as { audio: { pause: ReturnType<typeof vi.fn> } }).audio.pause).toHaveBeenCalledTimes(1);
  });
});

describe('AudioSourcePanel — locking', () => {
  it('disables source selection while a session is live, with a visible reason', () => {
    setSession({ capture: { isRecording: true } });
    render(<AudioSourcePanel />);

    expect(screen.getByRole('radio', { name: /^One microphone/ })).toBeDisabled();
    expect(screen.getByText(/locked while a session is live/i)).toBeInTheDocument();
  });

  it('leaves selection enabled when idle', () => {
    setSession();
    render(<AudioSourcePanel />);

    expect(screen.getByRole('radio', { name: /^One microphone/ })).not.toBeDisabled();
    expect(screen.queryByText(/locked while a session is live/i)).not.toBeInTheDocument();
  });

  // TASK-597 lane G: `isRecording` goes false at the Stop CLICK, so gating on
  // it alone re-enabled source selection while the transport was still
  // finalizing — a window in which the panel would describe a configuration the
  // just-closed run never used.
  it('keeps selection locked through the finalizing drain, with its own reason', () => {
    setSession({ capture: { isRecording: false, phase: 'stopping' } });
    render(<AudioSourcePanel />);

    expect(screen.getByRole('radio', { name: /^One microphone/ })).toBeDisabled();
    expect(screen.getByText(/locked until the transport finishes finalizing/i)).toBeInTheDocument();
  });
});
