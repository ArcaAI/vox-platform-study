import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `capture` group — stop ordering and the `stopping` phase.
 *
 * The defect (finding D2) was an ordering one at TWO layers. This suite owns
 * the app layer: the console must release the microphone before it waits on the
 * STT transport, and it must SAY that it is still finalizing rather than either
 * looking frozen (old behaviour) or looking finished while tail finals are
 * still landing.
 *
 * The SDK double below mirrors the fixed `useArcaAudio.stopAudio`: it flips
 * `isRecording` SYNCHRONOUSLY and returns a promise that stays pending for the
 * drain. Anything that reads as "recording" or "idle" during that window is the
 * bug this file exists to catch.
*/

const sdk = vi.hoisted(() => {
  const calls: string[] = [];
  const state = { isRecording: false };
  let release: (() => void) | null = null;

  return {
    calls,
    state,
    /** The provider's own `onTranscript`, captured by the hook mock below. */
    onTranscript: null as null | ((text: string, isFinal: boolean, meta?: Record<string, unknown>) => void),
    /** Complete the simulated transport drain. */
    releaseDrain: () => release?.(),
    reset: () => {
      calls.length = 0;
      state.isRecording = false;
      release = null;
    },
    startRecording: vi.fn(async () => {
      state.isRecording = true;
      calls.push('startRecording');
    }),
    stopRecording: vi.fn(() => {
      // Mic released synchronously, drain awaited after — the fixed SDK shape.
      calls.push('stopRecording');
      state.isRecording = false;
      return new Promise<void>((resolve) => {
        release = () => {
          calls.push('drain-resolved');
          resolve();
        };
      });
    }),
    startTranscription: vi.fn(async () => {
      calls.push('startTranscription');
    }),
    stopTranscription: vi.fn(async () => {
      calls.push('stopTranscription');
    }),
    sendAudioData: vi.fn(),
  };
});

vi.mock('@arcaai/vox/compat', () => ({
  useArcaSessionManager: () => ({ session: { id: 'sess-1', status: 'ACTIVE' }, isLoading: false, error: null }),
  useAudioCapture: () => ({
    isRecording: sdk.state.isRecording,
    deviceStatus: null,
    startRecording: sdk.startRecording,
    stopRecording: sdk.stopRecording,
    getDeviceStatus: vi.fn(async () => null),
    error: null,
    isReady: true,
  }),
  useArcaSpeechToText: (opts: { onTranscript: (text: string, isFinal: boolean, meta?: Record<string, unknown>) => void }) => {
    // Capture the provider's own callback so a test can push a tail final
    // through the SAME path the SDK uses, at the moment of its choosing.
    sdk.onTranscript = opts.onTranscript;
    return {
      transcript: '',
      startTranscription: sdk.startTranscription,
      stopTranscription: sdk.stopTranscription,
      sendAudioData: sdk.sendAudioData,
      uploadAudioFile: vi.fn(),
      getTranscriptionStatus: vi.fn(),
      isUploading: false,
      uploadProgress: 0,
      error: null,
    };
  },
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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PlaygroundSessionProvider, usePlaygroundSession, type PlaygroundSessionContextValue } from '../playground-session';
import type { PlaygroundConfig } from '../../lib/config-store';

const CONFIG: PlaygroundConfig = {
  apiEndpoint: 'http://localhost:8868',
  apiKey: 'test-key',
  tenantId: '50000000-0000-0000-0000-000000000000',
  pipelineId: '',
  languageMode: 'en',
};

let ctx: PlaygroundSessionContextValue;

function Probe() {
  ctx = usePlaygroundSession();
  return null;
}

function mount() {
  render(
    <PlaygroundSessionProvider config={CONFIG}>
      <Probe />
    </PlaygroundSessionProvider>,
  );
}

beforeEach(() => {
  sdk.reset();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('playground capture — stop ordering', () => {
  it('stops capture BEFORE the STT transport, and joins the same teardown', async () => {
    mount();
    await act(async () => {
      await ctx.capture.start();
    });
    expect(ctx.capture.phase).toBe('recording');

    let stopping!: Promise<void>;
    act(() => {
      stopping = ctx.capture.stop();
    });

    // The mic call went first. The old order was the exact reverse, and that is
    // what kept the recording indicator lit for the whole drain.
    expect(sdk.calls.slice(-2)).toEqual(['stopRecording', 'stopTranscription']);
    // Both were issued in the SAME tick, so the second joins the first teardown
    // instead of starting a second drain once the SDK's in-flight guard sees it.
    expect(sdk.calls).not.toContain('drain-resolved');

    await act(async () => {
      sdk.releaseDrain();
      await stopping;
    });
  });

  it('reports `stopping` — mic already off, session not yet idle — for the whole drain', async () => {
    mount();
    await act(async () => {
      await ctx.capture.start();
    });

    let stopping!: Promise<void>;
    act(() => {
      stopping = ctx.capture.stop();
    });

    // The user-visible claim: not recording any more, not finished either.
    expect(ctx.capture.isRecording).toBe(false);
    expect(ctx.capture.phase).toBe('stopping');

    await act(async () => {
      sdk.releaseDrain();
      await stopping;
    });

    expect(ctx.capture.phase).toBe('idle');
  });

  it('refuses to re-start while the previous session is still finalizing', async () => {
    mount();
    await act(async () => {
      await ctx.capture.start();
    });

    let stopping!: Promise<void>;
    act(() => {
      stopping = ctx.capture.stop();
    });
    sdk.startRecording.mockClear();

    // `isRecording` is already false here, so nothing but the phase stands
    // between a fast double-click and a start racing a half-closed session.
    await act(async () => {
      await ctx.capture.start();
    });
    expect(sdk.startRecording).not.toHaveBeenCalled();

    await act(async () => {
      sdk.releaseDrain();
      await stopping;
    });

    // ...and it is startable again the moment teardown genuinely completes.
    await act(async () => {
      await ctx.capture.start();
    });
    expect(sdk.startRecording).toHaveBeenCalledTimes(1);
  });

  it('a second Stop while finalizing does not issue a second teardown', async () => {
    mount();
    await act(async () => {
      await ctx.capture.start();
    });

    let stopping!: Promise<void>;
    act(() => {
      stopping = ctx.capture.stop();
    });
    act(() => {
      void ctx.capture.stop();
    });

    expect(sdk.stopRecording).toHaveBeenCalledTimes(1);
    expect(sdk.stopTranscription).toHaveBeenCalledTimes(1);

    await act(async () => {
      sdk.releaseDrain();
      await stopping;
    });
  });

  // ---------------------------------------------------------------------------
  // The reason the drain is still awaited at all.
  // ---------------------------------------------------------------------------
  it('appends a tail final that arrives DURING the drain, after the mic is off', async () => {
    mount();
    await act(async () => {
      await ctx.capture.start();
    });
    act(() => {
      sdk.onTranscript?.('first line', true, {});
    });
    expect(ctx.transcript.lines).toHaveLength(1);

    let stopping!: Promise<void>;
    act(() => {
      stopping = ctx.capture.stop();
    });
    expect(ctx.capture.isRecording).toBe(false);

    // Mic already released, phase `stopping` — and the server's last final
    // still lands in the buffer the Summarization tab reads.
    act(() => {
      sdk.onTranscript?.('the tail final', true, { speaker: '2' });
    });
    expect(ctx.capture.phase).toBe('stopping');
    expect(ctx.transcript.lines.map((l) => l.text)).toEqual(['first line', 'the tail final']);
    expect(ctx.transcript.lineTexts).toEqual(['first line', 'the tail final']);

    await act(async () => {
      sdk.releaseDrain();
      await stopping;
    });
    // Surviving the teardown matters as much as arriving during it.
    expect(ctx.transcript.lines.map((l) => l.text)).toEqual(['first line', 'the tail final']);
  });

  it('clears a stale interim once the stop teardown completes — no permanent "in progress" line', async () => {
    // Field defect: during silence the ASR emits partials that never finalize.
    // If the LAST event before Stop was such a partial, the console kept
    // rendering it as an italic in-progress line forever — reading as "the
    // last line is still being finalized" when the socket was already closed.
    mount();
    await act(async () => {
      await ctx.capture.start();
    });
    act(() => {
      sdk.onTranscript?.('a real line', true, {});
      sdk.onTranscript?.('silence partial that never finalizes', false, {});
    });
    expect(ctx.transcript.interim).toBe('silence partial that never finalizes');

    let stopping!: Promise<void>;
    act(() => {
      stopping = ctx.capture.stop();
    });
    // STILL shown while draining — a tail final may yet replace it.
    expect(ctx.transcript.interim).toBe('silence partial that never finalizes');

    await act(async () => {
      sdk.releaseDrain();
      await stopping;
    });
    // Drain over, socket closed — nothing can finalize this text anymore.
    expect(ctx.transcript.interim).toBe('');
    expect(ctx.transcript.lines.map((l) => l.text)).toEqual(['a real line']);
  });
});
