/**
 * CapturePanel pipeline-resolution test (TASK-330 P3 — bugfix).
 *
 * Regression guard for the "Pipeline …0002 not found" error: the clinical
 * workspace doctor lives in a customer tenant, but the SYSTEM-owned
 * DEFAULT_TRANSCRIPTION_PIPELINE_ID (…0002) is not shared-read into customer
 * tenants. The panel must resolve the per-user/tenant pipeline from the SDK
 * config (`resolvedConfig.stt.transcriptionPipelineId`, populated by
 * AgenticProvider from `remoteConfig.pipelineId`), exactly like the sibling
 * ConsultationRecordingPanel, falling back to the constant only as a last resort.
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

vi.mock('@/features/audio/constants', () => ({ DEFAULT_TRANSCRIPTION_PIPELINE_ID: 'pipe-default' }));

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
  bytesSent: 0,
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
}));

import { CapturePanel } from '../capture-panel';

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

  it('falls back to the default pipeline when config has no resolved id', () => {
    configState.resolvedConfig = { stt: {} };
    renderPanel();

    fireEvent.click(screen.getByTestId('ack-consent'));
    fireEvent.click(screen.getByTestId('capture-start'));

    expect(realtime.start).toHaveBeenCalledWith({ pipelineId: 'pipe-default', consultationId: 'c-1' });
  });
});
