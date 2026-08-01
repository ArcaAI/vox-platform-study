import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// --- Mocks -------------------------------------------------------------------
//
// TASK-597 lane C — the metadata simulator. Unlike `App.tabs.test.tsx` (which
// exercises the tab shell with an idle, never-recording session), these tests
// need a session that is ALREADY recording — the metadata controls are
// disabled otherwise (requirement 6) — plus a controllable `getDeviceStatus`
// so the auto-tag poll loop can be driven deterministically.

const sendAudioDataMock = vi.fn();
const getDeviceStatusMock = vi.fn().mockResolvedValue({ inputDevices: [], permissionStatus: 'granted', audioLevel: 0 });

vi.mock('@arcaai/vox/compat', () => ({
  ArcaCompatProvider: ({ children }: { children: ReactNode }) => children,
  useArcaSessionManager: () => ({ session: { id: 'sess-1', status: 'ACTIVE' }, isLoading: false, error: null }),
  useAudioCapture: () => ({
    isRecording: true,
    deviceStatus: null,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    getDeviceStatus: getDeviceStatusMock,
    error: null,
    isReady: true,
  }),
  useArcaSpeechToText: () => ({
    transcript: '',
    startTranscription: vi.fn(),
    stopTranscription: vi.fn(),
    sendAudioData: sendAudioDataMock,
    uploadAudioFile: vi.fn(),
    getTranscriptionStatus: vi.fn(),
    isUploading: false,
    uploadProgress: 0,
    error: null,
  }),
  useArcaSttLanguageModes: () => ({ modes: [], isLoading: false, error: null, refresh: vi.fn() }),
  useArcaSttProvider: () => ({
    usePipeline: false,
    switchStatus: 'idle',
    activeProvider: null,
    isFallbackActive: false,
    switchToPipeline: vi.fn(),
    switchToDefault: vi.fn(),
  }),
  useSMR: () => ({
    preSummarize: vi.fn(),
    summarize: vi.fn(),
    summarizeSync: vi.fn(),
    summarizeAsync: vi.fn(),
    loading: false,
    error: null,
  }),
}));

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Import AFTER the mocks are registered.
import { App } from '../../App';

/** Connect the console and land on the Live-transcription tab (a live, already-recording session). */
async function connectAndOpenLiveTab(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.clear(screen.getByLabelText(/API endpoint/i));
  await user.type(screen.getByLabelText(/API endpoint/i), 'http://localhost:8868');
  await user.type(screen.getByLabelText(/API key/i), 'test-key');
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByRole('button', { name: 'Disconnect' });
  await user.click(screen.getByRole('tab', { name: 'Live transcription' }));
}

beforeEach(() => {
  window.localStorage.clear();
  sendAudioDataMock.mockClear();
  getDeviceStatusMock.mockClear();
  getDeviceStatusMock.mockResolvedValue({ inputDevices: [], permissionStatus: 'granted', audioLevel: 0 });
  // SummaryCard's department fetch runs as soon as the (force-mounted)
  // Summarization panel renders — resolve it to the free-text fallback.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MetadataSimulator — manual send', () => {
  it('sends the manual speaker_id/language form and shows the round-tripped payload', async () => {
    const user = userEvent.setup();
    await connectAndOpenLiveTab(user);

    await user.type(screen.getByLabelText('speaker_id'), 'doctor');
    await user.click(screen.getByRole('button', { name: 'Send metadata' }));

    expect(sendAudioDataMock).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.objectContaining({ speaker_id: 'doctor' }));
    expect(await screen.findByText('Last sent')).toBeInTheDocument();
  });

  it('rejects an oversized manual payload with an inline field error, not a toast', async () => {
    const user = userEvent.setup();
    await connectAndOpenLiveTab(user);

    const oversized = JSON.stringify({ blob: 'x'.repeat(9000) });
    fireEvent.change(screen.getByLabelText('Additional metadata JSON'), { target: { value: oversized } });
    await user.click(screen.getByRole('button', { name: 'Send metadata' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/exceeds 8192 bytes/);
    expect(sendAudioDataMock).not.toHaveBeenCalled();
  });
});

describe('MetadataSimulator — per-mic rows', () => {
  it('sends a {mic, speaker} row and round-trips it onto the next transcript line', async () => {
    const user = userEvent.setup();
    await connectAndOpenLiveTab(user);

    const sendButtons = screen.getAllByRole('button', { name: 'Send' });
    await user.click(sendButtons[0]);

    expect(sendAudioDataMock).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.objectContaining({ mic: '1', speaker: '1' }));
  });

  it('rejects an oversized row payload with an inline field error scoped to that row', async () => {
    const user = userEvent.setup();
    await connectAndOpenLiveTab(user);

    const oversized = JSON.stringify({ blob: 'x'.repeat(9000) });
    const jsonFields = screen.getAllByLabelText(/^Additional metadata JSON for mic/);
    fireEvent.change(jsonFields[0], { target: { value: oversized } });

    const sendButtons = screen.getAllByRole('button', { name: 'Send' });
    await user.click(sendButtons[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent(/exceeds 8192 bytes/);
    expect(sendAudioDataMock).not.toHaveBeenCalled();
  });

  it('adds and removes rows, never dropping below one', async () => {
    const user = userEvent.setup();
    await connectAndOpenLiveTab(user);

    expect(screen.getAllByRole('button', { name: 'Send' })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Add mic row' }));
    expect(screen.getAllByRole('button', { name: 'Send' })).toHaveLength(3);

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(removeButtons[0]);
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    // Two rows removed from three — one left, and its Remove button is now disabled.
    expect(screen.getAllByRole('button', { name: 'Send' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });
});

describe('MetadataSimulator — auto-tag', () => {
  it('debounces to one emit per utterance: fires once while the level stays above threshold, again after it dips and re-crosses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await connectAndOpenLiveTab(user);

    await user.click(screen.getByRole('switch', { name: 'Auto-tag metadata rows on input level' }));

    // Sustained utterance: level stays above the default threshold (35) across
    // several poll ticks (200ms each) — must fire exactly once, not per tick.
    getDeviceStatusMock.mockResolvedValue({ inputDevices: [], permissionStatus: 'granted', audioLevel: 60 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200 * 5);
    });
    expect(sendAudioDataMock).toHaveBeenCalledTimes(1);
    expect(sendAudioDataMock).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.objectContaining({ mic: '1', speaker: '1' }));

    // Silence: level drops back below threshold — no new emits.
    getDeviceStatusMock.mockResolvedValue({ inputDevices: [], permissionStatus: 'granted', audioLevel: 5 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200 * 5);
    });
    expect(sendAudioDataMock).toHaveBeenCalledTimes(1);

    // Next utterance: crossing the threshold again fires the SECOND row (rotation).
    getDeviceStatusMock.mockResolvedValue({ inputDevices: [], permissionStatus: 'granted', audioLevel: 60 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200 * 5);
    });
    expect(sendAudioDataMock).toHaveBeenCalledTimes(2);
    expect(sendAudioDataMock).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), expect.objectContaining({ mic: '2', speaker: '2' }));
  });

  it('stops polling when the switch is off (default state)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await connectAndOpenLiveTab(user);

    getDeviceStatusMock.mockResolvedValue({ inputDevices: [], permissionStatus: 'granted', audioLevel: 90 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200 * 5);
    });

    expect(sendAudioDataMock).not.toHaveBeenCalled();
  });
});
