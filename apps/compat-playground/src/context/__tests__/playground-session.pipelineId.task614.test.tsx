import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `pipelineId` plumbing — (defect D-1).
 *
 * The console mounts BOTH compat hooks against the same audio graph and starts
 * capture FIRST (`playground-session.tsx` → `capture.startRecording()` then
 * `stt.startTranscription()`). Whichever hook calls `audio.start(...)` first
 * wins: the second call is discarded by the SDK's call-time idempotence guard
 * with nothing but an INFO log.
 *
 * So the pipeline id has to ride the hook that STARTS — `useAudioCapture`. It
 * did not, and the consequences were not cosmetic:
 *
 * 1. every "SDK-configured pipeline" session actually ran the tenant default
 * (the gateway resolves one when the client sends none), and
 * 2. `activePipeline` stayed `null` for the whole session, which is the state
 * `useArcaSttProvider` reads as "capture has not started" — so the STT-engine
 * toggle silently recorded a pre-start preference mid-session and never
 * issued the switch (D-2).
 *
 * These tests assert the id reaches the STARTING hook. Asserting it on
 * `useArcaSpeechToText` alone would have passed throughout the defect.
 */

const captured = vi.hoisted(() => ({
  audioCapture: null as null | Record<string, unknown>,
  speechToText: null as null | Record<string, unknown>,
}));

vi.mock('@arcaai/vox/compat', () => ({
  useArcaSessionManager: () => ({ session: { id: 'sess-1', status: 'ACTIVE' }, isLoading: false, error: null }),
  useAudioCapture: (props: Record<string, unknown>) => {
    captured.audioCapture = props;
    return {
      isRecording: false,
      deviceStatus: null,
      startRecording: vi.fn(async () => {}),
      stopRecording: vi.fn(async () => {}),
      getDeviceStatus: vi.fn(async () => null),
      error: null,
      isReady: true,
    };
  },
  useArcaSpeechToText: (props: Record<string, unknown>) => {
    captured.speechToText = props;
    return {
      transcript: '',
      startTranscription: vi.fn(async () => {}),
      stopTranscription: vi.fn(async () => {}),
      sendAudioData: vi.fn(),
      uploadAudioFile: vi.fn(),
      getTranscriptionStatus: vi.fn(),
      isUploading: false,
      uploadProgress: 0,
      error: null,
    };
  },
  useArcaSttLanguageModes: () => ({ modes: [], isLoading: false, error: null, refresh: vi.fn() }),
  useArcaBatchTranscription: () => ({
    items: [],
    enqueue: vi.fn(() => []),
    cancel: vi.fn(),
    retry: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    isUploading: false,
    isStreaming: false,
    activeCount: 0,
    error: null,
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PlaygroundSessionProvider } from '../playground-session';
import type { PlaygroundConfig } from '../../lib/config-store';

const BASE_CONFIG: PlaygroundConfig = {
  apiEndpoint: 'http://localhost:8868',
  apiKey: 'test-key',
  tenantId: '50000000-0000-0000-0000-000000000000',
  pipelineId: '',
  sttAgentSlug: '',
  languageMode: 'en',
};

function mount(config: Partial<PlaygroundConfig> = {}) {
  render(<PlaygroundSessionProvider config={{ ...BASE_CONFIG, ...config }}>{null}</PlaygroundSessionProvider>);
}

beforeEach(() => {
  captured.audioCapture = null;
  captured.speechToText = null;
  vi.clearAllMocks();
  window.localStorage.clear();
});

/**
 * AMENDED TASK-931. The hook that STARTS capture now carries the ASR AGENT SLUG, not the
 * deprecated pipeline id: `sttPipelineId` is removed in R4, and `useAudioCapture` forwards
 * `sttAgentSlug` as `agentSlug`. The pipeline id keeps its own field and keeps flowing to the
 * transcription and batch hooks, which accept no agent slug yet — so this file now pins BOTH,
 * which is exactly the transitional state it is describing.
 */
describe('playground selector plumbing', () => {
  it('gives the configured AGENT SLUG to the hook that STARTS capture', () => {
    mount({ sttAgentSlug: 'clinic-asr' });

    const options = captured.audioCapture?.options as { sttAgentSlug?: string } | undefined;
    expect(options?.sttAgentSlug).toBe('clinic-asr');
  });

  it('trims the configured agent slug before forwarding it', () => {
    mount({ sttAgentSlug: '  clinic-asr  ' });

    const options = captured.audioCapture?.options as { sttAgentSlug?: string } | undefined;
    expect(options?.sttAgentSlug).toBe('clinic-asr');
  });

  it('forwards `undefined`, never an empty string, when no agent is configured', () => {
    // An empty string is truthy on the wire once it reaches `audio.start`, and "let the tenant
    // assignment decide" must stay expressible. `undefined` is the only value the SDK reads as
    // "I did not choose one".
    mount({ sttAgentSlug: '   ' });

    const options = captured.audioCapture?.options as { sttAgentSlug?: string } | undefined;
    expect(options?.sttAgentSlug).toBeUndefined();
  });

  it('does NOT send the deprecated pipeline id on the capture hook any more', () => {
    mount({ pipelineId: 'pipeline-abc', sttAgentSlug: 'clinic-asr' });

    const options = captured.audioCapture?.options as { sttPipelineId?: string } | undefined;
    expect(options?.sttPipelineId).toBeUndefined();
  });

  it('keeps giving the same id to the transcription hook (order-independence)', () => {
    // Both hooks must carry it: which one wins the start race is an ordering
    // detail of the console, not a contract the SDK guarantees.
    mount({ pipelineId: 'pipeline-abc' });

    const sttOptions = captured.speechToText?.options as { pipelineId?: string } | undefined;
    expect(sttOptions?.pipelineId).toBe('pipeline-abc');
  });
});
