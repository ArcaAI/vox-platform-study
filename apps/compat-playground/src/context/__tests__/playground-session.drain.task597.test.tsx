import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `drain` group — the stop-drain knobs reach `useAudioCapture`.
 *
 * The SDK threads `quietWindowMs` all the way from `AudioStartOptions` to
 * `SttWebSocketClient.stopAndDrain`, but the console is the LAST hop: if the
 * provider does not spread the value into `useAudioCapture(...)`, the knob is
 * unreachable from the UI and the whole path is dead.
 *
 * The assertion that matters is `quietWindowMs: 0`. `0` is the value that
 * disables the quiet-window early resolve — the one setting that lets a tail
 * final land on a slow ASR pipeline — and it is the value a truthiness spread
 * (`...(quietWindowMs ? {quietWindowMs}: {})`) silently discards while still
 * passing every test written with a "nice" number.
 */

const captureProps: Array<Record<string, unknown>> = [];

vi.mock('@arcaai/vox/compat', () => ({
  useArcaSessionManager: () => ({ session: { id: 'sess-1', status: 'ACTIVE' }, isLoading: false, error: null }),
  useAudioCapture: (props: Record<string, unknown>) => {
    captureProps.push(props);
    return {
      isRecording: false,
      deviceStatus: null,
      sourceLevels: [],
      startRecording: vi.fn(async () => {}),
      stopRecording: vi.fn(async () => {}),
      getDeviceStatus: vi.fn(async () => null),
      error: null,
      isReady: true,
    };
  },
  useArcaSpeechToText: () => ({
    transcript: '',
    startTranscription: vi.fn(async () => {}),
    stopTranscription: vi.fn(async () => {}),
    sendAudioData: vi.fn(),
    uploadAudioFile: vi.fn(),
    getTranscriptionStatus: vi.fn(),
    isUploading: false,
    uploadProgress: 0,
    error: null,
  }),
  useArcaSttLanguageModes: () => ({ modes: [], isLoading: false, error: null, refresh: vi.fn() }),
  // The provider also mounts the batch-upload queue; an idle stub is
  // all these suites need (batch behaviour is covered in BatchUploadTab.test.tsx).
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

import { PlaygroundSessionProvider, usePlaygroundSession, WAIT_FOR_TAIL_FINAL_TIMEOUT_MS } from '../playground-session';
import { clearStoredConfig, type PlaygroundConfig } from '../../lib/config-store';

type Session = ReturnType<typeof usePlaygroundSession>;

const CONFIG: PlaygroundConfig = {
  apiEndpoint: 'http://localhost:8868',
  apiKey: 'k-1',
  tenantId: '',
  pipelineId: 'pipe-1',
  languageMode: 'ml-en',
};

/** Mount the provider and expose its context value to the test. */
function mount(config: PlaygroundConfig = CONFIG) {
  const ref: { current: Session | null } = { current: null };
  function Probe() {
    ref.current = usePlaygroundSession();
    return null;
  }
  render(
    <PlaygroundSessionProvider config={config}>
      <Probe />
    </PlaygroundSessionProvider>,
  );
  return ref;
}

/** The props handed to `useAudioCapture` on the most recent render. */
function latestCaptureProps() {
  return captureProps[captureProps.length - 1]!;
}

describe('playground-session — drain knobs reach useAudioCapture', () => {
  beforeEach(() => {
    captureProps.length = 0;
    clearStoredConfig();
  });

  it('passes NEITHER knob by default, so the SDK defaults apply', () => {
    mount();
    expect(latestCaptureProps()).not.toHaveProperty('drainTimeoutMs');
    expect(latestCaptureProps()).not.toHaveProperty('quietWindowMs');
  });

  it('PRESERVES quietWindowMs: 0 — a truthiness spread would drop it', () => {
    const ref = mount();
    act(() => ref.current!.drain.setQuietWindowMs(0));
    expect(latestCaptureProps()).toHaveProperty('quietWindowMs', 0);
  });

  it('forwards a positive drain timeout', () => {
    const ref = mount();
    act(() => ref.current!.drain.setTimeoutMs(30_000));
    expect(latestCaptureProps()).toHaveProperty('drainTimeoutMs', 30_000);
  });

  it('"wait for tail final" sets BOTH — quiet window 0 plus a long ceiling', () => {
    const ref = mount();
    act(() => ref.current!.drain.applyWaitForTailFinal());

    expect(ref.current!.drain.quietWindowMs).toBe(0);
    expect(ref.current!.drain.timeoutMs).toBe(WAIT_FOR_TAIL_FINAL_TIMEOUT_MS);
    // A long ceiling alone would not help: the quiet window fires first. Both
    // must arrive together for the tail final to be waited on at all.
    expect(latestCaptureProps()).toMatchObject({ quietWindowMs: 0, drainTimeoutMs: WAIT_FOR_TAIL_FINAL_TIMEOUT_MS });
  });

  it('reset drops both back to the SDK defaults', () => {
    const ref = mount();
    act(() => ref.current!.drain.applyWaitForTailFinal());
    expect(latestCaptureProps()).toHaveProperty('quietWindowMs', 0);

    act(() => ref.current!.drain.resetToDefaults());
    expect(latestCaptureProps()).not.toHaveProperty('quietWindowMs');
    expect(latestCaptureProps()).not.toHaveProperty('drainTimeoutMs');
  });

  it('seeds from the persisted config, including a stored 0', () => {
    mount({ ...CONFIG, drainTimeoutMs: 60_000, quietWindowMs: 0 });
    expect(latestCaptureProps()).toMatchObject({ drainTimeoutMs: 60_000, quietWindowMs: 0 });
  });
});
