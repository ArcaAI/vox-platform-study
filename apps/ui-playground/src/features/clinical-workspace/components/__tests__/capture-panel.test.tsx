/**
 * CapturePanel pipeline-resolution test (TASK-330 P3 — bugfix).
 *
 * Regression guard for the "Pipeline …0002 not found" error: the clinical
 * workspace doctor lives in a customer tenant, but the SYSTEM-owned
 * DEFAULT_TRANSCRIPTION_PIPELINE_ID (…0002) is not shared-read into customer
 * tenants. The panel must resolve the per-user/tenant pipeline from the SDK
 * config (`resolvedConfig.stt.transcriptionPipelineId`, populated by
 * AgenticProvider from `remoteConfig.pipelineId`), exactly like the sibling
 * ConsultationRecordingPanel, and block Start with an actionable error when none
 * resolves (TASK-342 R2 — no silent cross-tenant SYSTEM-default fallback).
 *
 * `@arcaai/vox` + `@arcaai/ui/*` are blanked by the ui-playground vitest config,
 * so the bits the panel touches are re-mocked here. The consent gate and dual
 * capture are stubbed so the test focuses on which pipeline id reaches `start`.
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, ...p }: any) => <span {...p}>{children}</span> }));
vi.mock('@arcaai/ui/button', () => ({ Button: ({ children, ...p }: any) => <button {...p}>{children}</button> }));
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/scroll-area', () => ({ ScrollArea: ({ children, ...p }: any) => <div {...p}>{children}</div> }));

// Stub the consent gate so the test can acknowledge consent with one click.
vi.mock('../consent-banner', () => ({
  ConsentBanner: ({ onAcknowledgedChange }: any) => (
    <button data-testid="ack-consent" onClick={() => onAcknowledgedChange(true)}>
      ack consent
    </button>
  ),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const realtime = vi.hoisted(() => ({
  isStreaming: false,
  sessionId: null as string | null,
  inputStream: null as unknown,
  transcripts: [] as Array<Record<string, unknown>>,
  // TASK-351 P0-6 — bytesSent is a subscribable handle, not a number.
  bytesSent: { subscribe: () => () => {}, getSnapshot: () => 0 },
  error: null as string | null,
  start: vi.fn(),
  stop: vi.fn(),
}));

const dual = vi.hoisted(() => ({
  status: 'idle' as string,
  isCapturing: false,
  start: vi.fn(),
  stopAndPersist: vi.fn(),
}));

// TASK-356 Phase 4 — the LOCAL transcription path drives the SDK browser
// pipeline via useArcaAudio (no STT-WS session, no pipelineId requirement).
const localAudio = vi.hoisted(() => ({
  isCapturing: false,
  currentTranscript: '',
  transcriptSegments: [] as Array<Record<string, unknown>>,
  level: 0,
  error: null as unknown,
  start: vi.fn(),
  stop: vi.fn(),
}));

const configState = vi.hoisted(() => ({ resolvedConfig: null as any }));

vi.mock('@/hooks/use-realtime-transcription', () => ({
  useRealtimeTranscription: () => ({
    status: realtime.isStreaming ? 'streaming' : 'idle',
    isStreaming: realtime.isStreaming,
    sessionId: realtime.sessionId,
    voiceProfileSeeded: null,
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

vi.mock('../../hooks/use-dual-capture', () => ({
  useDualCapture: () => ({
    status: dual.status,
    error: null,
    isCapturing: dual.isCapturing,
    lastResult: null,
    processedSource: null,
    start: dual.start,
    stopAndPersist: dual.stopAndPersist,
    reset: vi.fn(),
  }),
}));

vi.mock('../../api/clinical-workspace.api', () => ({
  startRecording: vi.fn().mockResolvedValue({ status: 'RECORDING' }),
  stopRecording: vi.fn().mockResolvedValue({ status: 'IDLE' }),
}));

vi.mock('@arcaai/vox', () => ({
  useArcaStore: (selector: any) => selector({ apiClient: { __fake: true } }),
  useArcaConfig: () => ({ resolvedConfig: configState.resolvedConfig }),
  useArcaAudio: () => ({
    isCapturing: localAudio.isCapturing,
    currentTranscript: localAudio.currentTranscript,
    transcriptSegments: localAudio.transcriptSegments,
    level: localAudio.level,
    error: localAudio.error,
    start: localAudio.start,
    stop: localAudio.stop,
  }),
}));

import { CapturePanel } from '../capture-panel';
import { toast } from 'sonner';

function renderPanel(props: Partial<React.ComponentProps<typeof CapturePanel>> = {}) {
  return render(
    <CapturePanel
      consultationId="c-1"
      recording={false}
      onRecordingStarted={vi.fn()}
      onRecordingStopped={vi.fn()}
      {...props}
    />,
  );
}

describe('CapturePanel pipeline resolution (Pipeline-not-found bugfix)', () => {
  beforeEach(() => {
    realtime.isStreaming = false;
    realtime.sessionId = null;
    realtime.inputStream = null;
    realtime.transcripts = [];
    realtime.error = null;
    realtime.start = vi.fn().mockResolvedValue(undefined);
    realtime.stop = vi.fn().mockResolvedValue(undefined);
    dual.status = 'idle';
    dual.isCapturing = false;
    configState.resolvedConfig = null;
    localAudio.isCapturing = false;
    localAudio.currentTranscript = '';
    localAudio.transcriptSegments = [];
    localAudio.start = vi.fn().mockResolvedValue(undefined);
    localAudio.stop = vi.fn().mockResolvedValue(undefined);
  });

  it('uses the resolved remote pipeline id from config when no prop is given', () => {
    configState.resolvedConfig = { stt: { transcriptionPipelineId: 'pipe-remote' } };
    renderPanel();

    fireEvent.click(screen.getByTestId('ack-consent'));
    fireEvent.click(screen.getByTestId('capture-start'));

    expect(realtime.start).toHaveBeenCalledWith({ pipelineId: 'pipe-remote', consultationId: 'c-1' });
  });

  it('prefers an explicit pipeline prop over the resolved config id', () => {
    configState.resolvedConfig = { stt: { transcriptionPipelineId: 'pipe-remote' } };
    renderPanel({ pipelineId: 'pipe-x' });

    fireEvent.click(screen.getByTestId('ack-consent'));
    fireEvent.click(screen.getByTestId('capture-start'));

    expect(realtime.start).toHaveBeenCalledWith({ pipelineId: 'pipe-x', consultationId: 'c-1' });
  });

  it('blocks Start with an actionable error when no pipeline id resolves (no silent SYSTEM default) — TASK-342 R2', () => {
    configState.resolvedConfig = { stt: {} };
    renderPanel();

    fireEvent.click(screen.getByTestId('ack-consent'));
    fireEvent.click(screen.getByTestId('capture-start'));

    // No cross-tenant SYSTEM-default fallback: the session is never started, and
    // the doctor gets an actionable error instead of a 404 "Pipeline not found".
    expect(realtime.start).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/pipeline/i));
  });
});

// TASK-356 Phase 4 (UI-T3) — the panel branches on the server-resolved effective
// transcription mode (resolvedConfig.stt.transcriptionMode). BACKEND keeps the
// existing STT-WS path (pipelineId required); LOCAL drives the SDK browser
// pipeline with NO pipelineId requirement.
describe('CapturePanel transcription-mode branch (TASK-356 Phase 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    realtime.isStreaming = false;
    realtime.sessionId = null;
    realtime.inputStream = null;
    realtime.transcripts = [];
    realtime.error = null;
    realtime.start = vi.fn().mockResolvedValue(undefined);
    realtime.stop = vi.fn().mockResolvedValue(undefined);
    dual.status = 'idle';
    dual.isCapturing = false;
    configState.resolvedConfig = null;
    localAudio.isCapturing = false;
    localAudio.transcriptSegments = [];
    localAudio.start = vi.fn().mockResolvedValue(undefined);
    localAudio.stop = vi.fn().mockResolvedValue(undefined);
  });

  it('LOCAL — starts the SDK browser pipeline (no pipelineId) and does NOT open an STT-WS session', async () => {
    configState.resolvedConfig = { stt: { transcriptionMode: 'LOCAL' } };
    renderPanel();

    fireEvent.click(screen.getByTestId('ack-consent'));
    fireEvent.click(screen.getByTestId('capture-start'));

    await Promise.resolve();

    // Browser pipeline started; no `pipelineId` is required or forwarded.
    expect(localAudio.start).toHaveBeenCalledTimes(1);
    const startArg = localAudio.start.mock.calls[0]?.[0] ?? {};
    expect(startArg.pipelineId).toBeUndefined();
    // The remote STT-WS path is NOT taken.
    expect(realtime.start).not.toHaveBeenCalled();
  });

  it('LOCAL — does NOT block on a missing transcription pipeline (no remote pipeline needed)', () => {
    // No transcriptionPipelineId resolves, but LOCAL needs none.
    configState.resolvedConfig = { stt: { transcriptionMode: 'LOCAL' } };
    renderPanel();

    fireEvent.click(screen.getByTestId('ack-consent'));
    fireEvent.click(screen.getByTestId('capture-start'));

    expect(toast.error).not.toHaveBeenCalled();
    expect(localAudio.start).toHaveBeenCalledTimes(1);
  });

  it('LOCAL — correlates the recording without an STT-WS session id', async () => {
    const { startRecording } = await import('../../api/clinical-workspace.api');
    configState.resolvedConfig = { stt: { transcriptionMode: 'LOCAL' } };
    const onRecordingStarted = vi.fn();
    renderPanel({ onRecordingStarted });

    fireEvent.click(screen.getByTestId('ack-consent'));
    fireEvent.click(screen.getByTestId('capture-start'));

    await Promise.resolve();
    await Promise.resolve();

    // startRecording is called with NO sessionId (local pipeline has no WS session).
    expect(startRecording).toHaveBeenCalledWith({ __fake: true }, 'c-1');
  });

  it('BACKEND — an explicit BACKEND mode keeps the STT-WS path with the resolved pipelineId', () => {
    configState.resolvedConfig = { stt: { transcriptionMode: 'BACKEND', transcriptionPipelineId: 'pipe-remote' } };
    renderPanel();

    fireEvent.click(screen.getByTestId('ack-consent'));
    fireEvent.click(screen.getByTestId('capture-start'));

    expect(realtime.start).toHaveBeenCalledWith({ pipelineId: 'pipe-remote', consultationId: 'c-1' });
    expect(localAudio.start).not.toHaveBeenCalled();
  });
});
