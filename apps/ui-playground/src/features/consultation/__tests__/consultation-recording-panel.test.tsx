/**
 * ConsultationRecordingPanel smoke test (TASK-329 P2 — Recording tab)
 *
 * Verifies in-flow capture wiring:
 *   - lists the consultation's recordings on mount
 *   - dual-capture (X8) recordings show the "Dual capture" badge
 *   - empty state when there are no recordings
 *   - Start calls the realtime session scoped to the consultation
 *   - while streaming, Stop is shown and stops the session
 *   - F8: the diarization voice-profile seeding indicator is surfaced
 *   - F2: real dual capture — when enabled, stopping uploads raw+processed and
 *         registers the recording with both media ids; when disabled, only the
 *         single mediaId is registered (single-stream recording still works)
 *
 * The ui-playground vitest config stubs `@arcaai/ui/*` + `@arcaai/vox` with
 * `export default {}`, so each primitive/hook is mocked here.
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { toast } from 'sonner';

vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, ...p }: any) => <button {...p}>{children}</button>,
}));
vi.mock('@arcaai/ui/badge', () => ({
  Badge: ({ children, ...p }: any) => <span {...p}>{children}</span>,
}));
vi.mock('@arcaai/ui/skeleton', () => ({
  Skeleton: (p: any) => <div data-testid="skeleton" {...p} />,
}));
vi.mock('@/features/audio/constants', () => ({
  SUPPORTED_LANGUAGES: [],
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const realtime = vi.hoisted(() => ({
  status: 'idle' as string,
  isStreaming: false,
  voiceProfileSeeded: null as boolean | null,
  transcripts: [] as Array<Record<string, unknown>>,
  error: null as string | null,
  // TASK-351 P0-6 — bytesSent is a subscribable handle, not a number.
  bytesSent: { subscribe: () => () => {}, getSnapshot: () => 0 },
  inputStream: null as unknown,
  start: vi.fn(),
  stop: vi.fn(),
}));

const recordingsState = vi.hoisted(() => ({
  recordings: [] as Array<Record<string, unknown>>,
  isLoading: false,
  error: null as Error | null,
  list: vi.fn(),
  add: vi.fn(),
}));

const storageState = vi.hoisted(() => ({ uploadFile: vi.fn() }));
const configState = vi.hoisted(() => ({ resolvedConfig: null as any }));
// TASK-332 — local raw capture uses a single MediaRecorder (not DualStreamRecorder).
const mediaRec = vi.hoisted(() => ({ instances: [] as any[] }));

class MockMediaRecorder {
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: unknown) {
    mediaRec.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['raw-audio'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

vi.mock('@/hooks/use-realtime-transcription', () => ({
  useRealtimeTranscription: () => ({
    status: realtime.status,
    isStreaming: realtime.isStreaming,
    sessionId: null,
    voiceProfileSeeded: realtime.voiceProfileSeeded,
    transcripts: realtime.transcripts,
    error: realtime.error,
    bytesSent: realtime.bytesSent,
    reconnectAttempts: 0,
    inputStream: realtime.inputStream,
    start: realtime.start,
    stop: realtime.stop,
    clearTranscripts: vi.fn(),
  }),
}));

vi.mock('@arcaai/vox', () => ({
  useAudioRecordings: () => ({
    recordings: recordingsState.recordings,
    isLoading: recordingsState.isLoading,
    error: recordingsState.error,
    list: recordingsState.list,
    add: recordingsState.add,
  }),
  useStorage: () => ({ uploadFile: storageState.uploadFile }),
  useArcaConfig: () => ({ resolvedConfig: configState.resolvedConfig }),
}));

import { ConsultationRecordingPanel } from '../components/consultation-recording-panel';

describe('ConsultationRecordingPanel (TASK-329 P2)', () => {
  beforeEach(() => {
    realtime.status = 'idle';
    realtime.isStreaming = false;
    realtime.voiceProfileSeeded = null;
    realtime.transcripts = [];
    realtime.error = null;
    realtime.bytesSent = { subscribe: () => () => {}, getSnapshot: () => 0 };
    realtime.inputStream = null;
    realtime.start = vi.fn().mockResolvedValue(undefined);
    realtime.stop = vi.fn().mockResolvedValue(undefined);

    recordingsState.recordings = [];
    recordingsState.isLoading = false;
    recordingsState.error = null;
    recordingsState.list = vi.fn().mockResolvedValue([]);
    recordingsState.add = vi.fn().mockResolvedValue({ id: 'ctx-1' });

    // TASK-656 — the real StorageController.uploadFile response carries BOTH the
    // raw storage `key` AND a `mediaId` (a Media table row UUID); mock both so
    // callers exercising the fixed mediaId-based flow see realistic data.
    storageState.uploadFile = vi
      .fn()
      .mockImplementation((_bucket: string, file: File) => Promise.resolve({ key: `key-${file.name}`, mediaId: `media-${file.name}` }));
    configState.resolvedConfig = null;
    mediaRec.instances = [];
    vi.mocked(toast.error).mockClear();
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
  });

  it('lists recordings for the consultation on mount', () => {
    render(<ConsultationRecordingPanel consultationId="c-1" />);
    expect(recordingsState.list).toHaveBeenCalledWith('c-1');
  });

  it('shows the empty state when there are no recordings', () => {
    render(<ConsultationRecordingPanel consultationId="c-1" />);
    expect(screen.getByText(/No recordings yet/i)).toBeInTheDocument();
  });

  it('renders recordings and flags dual-capture ones', () => {
    recordingsState.recordings = [
      { id: 'ar-1', mediaId: 'media-aaaaaaaa', sequenceNumber: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      {
        id: 'ar-2',
        mediaId: 'media-bbbbbbbb',
        rawMediaId: 'raw-cccccccc',
        processedMediaId: 'proc-dddddddd',
        sequenceNumber: 2,
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ];
    render(<ConsultationRecordingPanel consultationId="c-1" />);

    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    // only the second recording carries raw/processed ids → one dual-capture badge
    expect(screen.getAllByText('Dual capture')).toHaveLength(1);
  });

  // TASK-364 — there is NO silent cross-tenant fallback. With no prop and no
  // cascade-resolved pipeline, Start must be blocked with an actionable error
  // rather than starting a session against the SYSTEM-tenant pipeline (404 risk).
  it('blocks Start with an actionable error when no pipeline is configured', () => {
    render(<ConsultationRecordingPanel consultationId="c-1" />);
    fireEvent.click(screen.getByText('Start recording'));
    expect(realtime.start).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('honours an explicit pipeline override', () => {
    render(<ConsultationRecordingPanel consultationId="c-1" pipelineId="pipe-x" />);
    fireEvent.click(screen.getByText('Start recording'));
    expect(realtime.start).toHaveBeenCalledWith({ pipelineId: 'pipe-x', consultationId: 'c-1' });
  });

  // TASK-333 T5 — pipeline selection resolves the user's remote pipeline id
  // (cascade-resolved via the SDK config hook). TASK-364 removed the silent
  // constant fallback; an unresolved pipeline now blocks Start (see above).
  it('uses the resolved remote pipeline id from config when no prop is given', () => {
    configState.resolvedConfig = { stt: { transcriptionPipelineId: 'pipe-remote' } };
    render(<ConsultationRecordingPanel consultationId="c-1" />);
    fireEvent.click(screen.getByText('Start recording'));
    expect(realtime.start).toHaveBeenCalledWith({ pipelineId: 'pipe-remote', consultationId: 'c-1' });
  });

  it('prefers an explicit pipeline prop over the resolved config id', () => {
    configState.resolvedConfig = { stt: { transcriptionPipelineId: 'pipe-remote' } };
    render(<ConsultationRecordingPanel consultationId="c-1" pipelineId="pipe-x" />);
    fireEvent.click(screen.getByText('Start recording'));
    expect(realtime.start).toHaveBeenCalledWith({ pipelineId: 'pipe-x', consultationId: 'c-1' });
  });

  it('blocks Start when config resolves no pipeline id (no silent default)', () => {
    configState.resolvedConfig = { audio: { dualCapture: false } };
    render(<ConsultationRecordingPanel consultationId="c-1" />);
    fireEvent.click(screen.getByText('Start recording'));
    expect(realtime.start).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('shows Stop while streaming and stops the session', () => {
    realtime.isStreaming = true;
    realtime.status = 'streaming';
    render(<ConsultationRecordingPanel consultationId="c-1" />);

    const stop = screen.getByText('Stop');
    expect(stop).toBeInTheDocument();
    fireEvent.click(stop);
    expect(realtime.stop).toHaveBeenCalled();
  });

  // F8 — diarization voice-profile seeding feedback (parity with the Audio playground).
  it('surfaces the diarization seeding indicator when the session reports a seeded profile', () => {
    realtime.isStreaming = true;
    realtime.status = 'streaming';
    realtime.voiceProfileSeeded = true;
    render(<ConsultationRecordingPanel consultationId="c-1" />);
    expect(screen.getByText('Voice profile seeded')).toBeInTheDocument();
  });

  it('does not render the seeding indicator before a session reports a value', () => {
    realtime.voiceProfileSeeded = null;
    render(<ConsultationRecordingPanel consultationId="c-1" />);
    expect(screen.queryByText('Voice profile seeded')).not.toBeInTheDocument();
    expect(screen.queryByText('Diarization not personalized')).not.toBeInTheDocument();
  });

  // TASK-332 — local raw-stream capture. When the effective flag is ON and the
  // active pipeline is LOCAL (stt.provider === 'local'), the raw mic is recorded
  // as a SINGLE blob via one MediaRecorder, uploaded, and attached as an
  // AUDIO_RECORDING context item. There is no separate "processed" artifact on
  // the local path (the transcription IS the processed output).
  describe('local raw capture (TASK-332)', () => {
    beforeEach(() => {
      realtime.isStreaming = true;
      realtime.status = 'streaming';
      realtime.inputStream = { getAudioTracks: () => [{ kind: 'audio' }] };
    });

    it('when enabled + local pipeline, stopping records the raw mic, uploads it, and attaches an AUDIO_RECORDING context item', async () => {
      configState.resolvedConfig = { audio: { captureRawAudio: true }, stt: { provider: 'local' } };
      render(<ConsultationRecordingPanel consultationId="c-1" />);

      // a single MediaRecorder is started for the raw mic (not DualStreamRecorder)
      await waitFor(() => expect(mediaRec.instances).toHaveLength(1));

      fireEvent.click(screen.getByText('Stop'));

      await waitFor(() => expect(recordingsState.add).toHaveBeenCalledTimes(1));
      expect(storageState.uploadFile).toHaveBeenCalledTimes(1);
      expect(storageState.uploadFile).toHaveBeenCalledWith('attachments', expect.any(File));
      // TASK-656 — mediaId (the Media row UUID), never the raw storage key.
      expect(recordingsState.add).toHaveBeenCalledWith('c-1', { mediaId: 'media-raw.webm' });
    });

    it('when the flag is OFF, stopping does NOT capture or upload anything', async () => {
      configState.resolvedConfig = { audio: { captureRawAudio: false }, stt: { provider: 'local' } };
      render(<ConsultationRecordingPanel consultationId="c-1" />);

      expect(mediaRec.instances).toHaveLength(0);

      fireEvent.click(screen.getByText('Stop'));

      await waitFor(() => expect(realtime.stop).toHaveBeenCalled());
      expect(storageState.uploadFile).not.toHaveBeenCalled();
      expect(recordingsState.add).not.toHaveBeenCalled();
    });

    it('does NOT capture on a remote pipeline even when the flag is ON (remote path unaffected)', async () => {
      configState.resolvedConfig = { audio: { captureRawAudio: true }, stt: { provider: 'backend' } };
      render(<ConsultationRecordingPanel consultationId="c-1" />);

      expect(mediaRec.instances).toHaveLength(0);

      fireEvent.click(screen.getByText('Stop'));

      await waitFor(() => expect(realtime.stop).toHaveBeenCalled());
      expect(storageState.uploadFile).not.toHaveBeenCalled();
      expect(recordingsState.add).not.toHaveBeenCalled();
    });
  });
});
