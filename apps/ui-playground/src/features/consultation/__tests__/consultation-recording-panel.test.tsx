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
  DEFAULT_TRANSCRIPTION_PIPELINE_ID: 'pipe-default',
  SUPPORTED_LANGUAGES: [],
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const realtime = vi.hoisted(() => ({
  status: 'idle' as string,
  isStreaming: false,
  voiceProfileSeeded: null as boolean | null,
  transcripts: [] as Array<Record<string, unknown>>,
  error: null as string | null,
  bytesSent: 0,
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
const dual = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), ctorArgs: [] as any[][] }));

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
  DualStreamRecorder: class {
    constructor(...args: any[]) {
      dual.ctorArgs.push(args);
    }
    start() {
      dual.start();
    }
    stop() {
      return dual.stop();
    }
  },
}));

import { ConsultationRecordingPanel } from '../components/consultation-recording-panel';

describe('ConsultationRecordingPanel (TASK-329 P2)', () => {
  beforeEach(() => {
    realtime.status = 'idle';
    realtime.isStreaming = false;
    realtime.voiceProfileSeeded = null;
    realtime.transcripts = [];
    realtime.error = null;
    realtime.bytesSent = 0;
    realtime.inputStream = null;
    realtime.start = vi.fn().mockResolvedValue(undefined);
    realtime.stop = vi.fn().mockResolvedValue(undefined);

    recordingsState.recordings = [];
    recordingsState.isLoading = false;
    recordingsState.error = null;
    recordingsState.list = vi.fn().mockResolvedValue([]);
    recordingsState.add = vi.fn().mockResolvedValue({ id: 'ctx-1' });

    storageState.uploadFile = vi.fn().mockImplementation((_bucket: string, file: File) => Promise.resolve({ key: `key-${file.name}` }));
    configState.resolvedConfig = null;
    dual.start = vi.fn();
    dual.stop = vi.fn().mockResolvedValue({ raw: new Blob(['raw']), processed: new Blob(['proc']) });
    dual.ctorArgs = [];
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

  it('starts a consultation-scoped session with the default pipeline', () => {
    render(<ConsultationRecordingPanel consultationId="c-1" />);
    fireEvent.click(screen.getByText('Start recording'));
    expect(realtime.start).toHaveBeenCalledWith({ pipelineId: 'pipe-default', consultationId: 'c-1' });
  });

  it('honours an explicit pipeline override', () => {
    render(<ConsultationRecordingPanel consultationId="c-1" pipelineId="pipe-x" />);
    fireEvent.click(screen.getByText('Start recording'));
    expect(realtime.start).toHaveBeenCalledWith({ pipelineId: 'pipe-x', consultationId: 'c-1' });
  });

  // TASK-333 T5 — pipeline selection resolves the user's remote pipeline id
  // (cascade-resolved via the SDK config hook), falling back to the constant.
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

  it('falls back to the default pipeline when config has no resolved id', () => {
    configState.resolvedConfig = { audio: { dualCapture: false } };
    render(<ConsultationRecordingPanel consultationId="c-1" />);
    fireEvent.click(screen.getByText('Start recording'));
    expect(realtime.start).toHaveBeenCalledWith({ pipelineId: 'pipe-default', consultationId: 'c-1' });
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

  // F2 — real dual capture wired through DualStreamRecorder + upload + add().
  describe('dual capture (F2)', () => {
    beforeEach(() => {
      realtime.isStreaming = true;
      realtime.status = 'streaming';
      realtime.inputStream = { getAudioTracks: () => [{ kind: 'audio' }] };
    });

    it('when enabled, stopping uploads raw+processed and registers both media ids', async () => {
      configState.resolvedConfig = { audio: { dualCapture: true } };
      render(<ConsultationRecordingPanel consultationId="c-1" />);

      // the dual recorder is started for the live capture
      expect(dual.start).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByText('Stop'));

      await waitFor(() => expect(recordingsState.add).toHaveBeenCalledTimes(1));
      expect(recordingsState.add).toHaveBeenCalledWith('c-1', {
        mediaId: 'key-processed.webm',
        rawMediaId: 'key-raw.webm',
        processedMediaId: 'key-processed.webm',
      });
    });

    it('when disabled, stopping registers a single mediaId only (single-stream)', async () => {
      configState.resolvedConfig = { audio: { dualCapture: false } };
      render(<ConsultationRecordingPanel consultationId="c-1" />);

      fireEvent.click(screen.getByText('Stop'));

      await waitFor(() => expect(recordingsState.add).toHaveBeenCalledTimes(1));
      expect(recordingsState.add).toHaveBeenCalledWith('c-1', { mediaId: 'key-processed.webm' });
    });
  });
});
