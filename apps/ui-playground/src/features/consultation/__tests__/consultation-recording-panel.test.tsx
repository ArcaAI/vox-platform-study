/**
 * ConsultationRecordingPanel smoke test (TASK-329 P2 — Recording tab)
 *
 * Verifies in-flow capture wiring:
 *   - lists the consultation's recordings on mount
 *   - dual-capture (X8) recordings show the "Dual capture" badge
 *   - empty state when there are no recordings
 *   - Start calls the realtime session scoped to the consultation
 *   - while streaming, Stop is shown and stops the session
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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
  transcripts: [] as Array<Record<string, unknown>>,
  error: null as string | null,
  bytesSent: 0,
  start: vi.fn(),
  stop: vi.fn(),
}));

const recordingsState = vi.hoisted(() => ({
  recordings: [] as Array<Record<string, unknown>>,
  isLoading: false,
  error: null as Error | null,
  list: vi.fn(),
}));

vi.mock('@/hooks/use-realtime-transcription', () => ({
  useRealtimeTranscription: () => ({
    status: realtime.status,
    isStreaming: realtime.isStreaming,
    sessionId: null,
    transcripts: realtime.transcripts,
    error: realtime.error,
    bytesSent: realtime.bytesSent,
    reconnectAttempts: 0,
    inputStream: null,
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
    add: vi.fn(),
  }),
}));

import { ConsultationRecordingPanel } from '../components/consultation-recording-panel';

describe('ConsultationRecordingPanel (TASK-329 P2)', () => {
  beforeEach(() => {
    realtime.status = 'idle';
    realtime.isStreaming = false;
    realtime.transcripts = [];
    realtime.error = null;
    realtime.bytesSent = 0;
    realtime.start = vi.fn().mockResolvedValue(undefined);
    realtime.stop = vi.fn().mockResolvedValue(undefined);

    recordingsState.recordings = [];
    recordingsState.isLoading = false;
    recordingsState.error = null;
    recordingsState.list = vi.fn().mockResolvedValue([]);
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

  it('shows Stop while streaming and stops the session', () => {
    realtime.isStreaming = true;
    realtime.status = 'streaming';
    render(<ConsultationRecordingPanel consultationId="c-1" />);

    const stop = screen.getByText('Stop');
    expect(stop).toBeInTheDocument();
    fireEvent.click(stop);
    expect(realtime.stop).toHaveBeenCalled();
  });
});
