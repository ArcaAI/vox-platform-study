/**
 * TASK-977 (D-6) — the two browser paths the TASK-865 gate never covered.
 *
 * The owner directive is unchanged since 2026-09-04: the browser captures audio
 * and renders results, it never runs a model. `TranscriptionPipeline` enforces
 * that with `audio.clientInference: { allow: true }` — but its gate helper is
 * literally typed `(stage: 'noiseFilter' | 'vad')`, so two live paths ran a
 * browser model OUTSIDE it:
 *
 *  1. `useLocalVoiceEmbedding` — a WavLM speaker-verification model (this is the
 *     "voice embedding for diarization" the directive names), guarded only by a
 *     `console.warn`.
 *  2. The raw `useVAD` / `useSTT` / `useNoiseFilter` re-exports on
 *     `@arcaai/vox/plugins` — bare pass-throughs that bypass the pipeline
 *     entirely, so the gate never sees them.
 *
 * D-6 closes both NOW rather than at R4. The claims below mirror the shape of
 * `client-inference-gate.task865.test.ts`, POSITIVE CONTROL included: every
 * "it refuses" claim is paired with a "the allow opens it" claim, so a gate that
 * was simply broken could not pass this file.
 *
 * `useSTT` is deliberately NOT gated wholesale — it is the capture/transport
 * surface as well as the local-model surface, and its `provider` defaults to
 * `'remote'`. Only `provider: 'local'` (in-browser Whisper) is gated.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { renderHook, act } from '@testing-library/react';
import { AgenticStoreContext, createAgenticStore, type AgenticStoreApi } from '../store/agenticStore';
import { AgenticError, type AgenticConfig } from '../types';

// The underlying package hooks are mocked so the assertion is "was the real hook
// even reached", not "did a model download".
const rawUseVAD = vi.fn();
const rawUseSTT = vi.fn();
const rawUseNoiseFilter = vi.fn();

vi.mock('@arcaai/vad', () => ({ useVAD: (...args: unknown[]) => rawUseVAD(...args) }));
vi.mock('@arcaai/stt', () => ({ useSTT: (...args: unknown[]) => rawUseSTT(...args) }));
vi.mock('@arcaai/noise-filter', () => ({ useNoiseFilter: (...args: unknown[]) => rawUseNoiseFilter(...args) }));

// `useLocalVoiceEmbedding` persists through the EXISTING backend enroll path;
// mock it so the gate is the only thing under test.
const mockBackendEnroll = vi.fn();
vi.mock('../hooks/useVoiceEmbedding', () => ({
  useVoiceEmbedding: () => ({
    profiles: [],
    isLoading: false,
    isUploading: false,
    error: null,
    enroll: mockBackendEnroll,
    list: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
    delete: vi.fn(),
  }),
}));

import { useVAD, useSTT, useNoiseFilter } from '../hooks/useGatedClientStages';
import { useLocalVoiceEmbedding } from '../hooks/useLocalVoiceEmbedding';
import type { LocalVoiceEmbedder } from '../core/LocalVoiceEmbedder';
import type { AudioTrack } from '@arcaai/room';

/** `Array.prototype.at` is past this package's tsconfig lib target. */
function lastCall(mock: { mock: { calls: unknown[][] } }): unknown[] {
  return mock.mock.calls[mock.mock.calls.length - 1]!;
}

/** A live-looking track — the wrappers must still refuse to hand it over. */
const track = { kind: 'audio', setProcessor: vi.fn() } as unknown as AudioTrack;

function inertVadReturn() {
  return { attach: vi.fn(), detach: vi.fn(), isAttached: false, processor: null };
}

/** A store wired exactly as `AgenticProvider` wires it, minus the provider. */
function storeWith(audio?: AgenticConfig['audio']): AgenticStoreApi {
  const api = createAgenticStore();
  api.setState({
    config: { api: { tenantId: 'tenant-1', baseUrl: 'https://example.invalid' }, audio } as AgenticConfig,
    authUser: { id: 'user-1' } as never,
  });
  return api;
}

function wrapperFor(api: AgenticStoreApi) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(AgenticStoreContext.Provider, { value: api }, children);
  };
}

const ALLOWED: AgenticConfig['audio'] = { clientInference: { allow: true } };

function fakeEmbedder(): LocalVoiceEmbedder {
  return {
    modelId: 'Xenova/wavlm-base-plus-sv',
    load: vi.fn(async () => {}),
    embed: vi.fn(async () => [1, 0, 0]),
    embedBlob: vi.fn(async () => [1, 0, 0]),
    dispose: vi.fn(() => {}),
  } as unknown as LocalVoiceEmbedder;
}

function audioFile(): File {
  return new File([new Uint8Array([1, 2, 3, 4])], 'sample.wav', { type: 'audio/wav' });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  rawUseVAD.mockReturnValue(inertVadReturn());
  rawUseSTT.mockReturnValue({ attach: vi.fn(), detach: vi.fn(), transcribeSegment: vi.fn(), isAttached: false, processor: null });
  rawUseNoiseFilter.mockReturnValue({ attach: vi.fn(), detach: vi.fn(), isAttached: false, processor: null });
  mockBackendEnroll.mockResolvedValue({ id: 'profile-1', userId: 'user-1', label: 'Doc Mic' });
});

describe('useLocalVoiceEmbedding — the WavLM speaker model is behind clientInference.allow', () => {
  it('reports supported: false and never loads the model when the host stated no allow', async () => {
    const embedder = fakeEmbedder();
    const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder }), { wrapper: wrapperFor(storeWith()) });

    expect(result.current.supported).toBe(false);
    await expect(result.current.preloadModel()).rejects.toBeInstanceOf(AgenticError);
    expect(embedder.load).not.toHaveBeenCalled();
  });

  it('refuses enroll and quickTest with the typed code, without touching the embedder or the backend', async () => {
    const embedder = fakeEmbedder();
    const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder }), { wrapper: wrapperFor(storeWith()) });

    await expect(result.current.enroll(audioFile())).rejects.toMatchObject({ code: 'CLIENT_INFERENCE_DISABLED' });
    await expect(result.current.quickTest(audioFile())).rejects.toMatchObject({ code: 'CLIENT_INFERENCE_DISABLED' });

    expect(embedder.load).not.toHaveBeenCalled();
    expect(embedder.embedBlob).not.toHaveBeenCalled();
    // The gate refuses the CALL, so the server-side half never runs either —
    // a host that wants server enrolment uses `useVoiceEmbedding` directly.
    expect(mockBackendEnroll).not.toHaveBeenCalled();
  });

  it('names the switch in the refusal message so the host can find it', async () => {
    const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder: fakeEmbedder() }), {
      wrapper: wrapperFor(storeWith()),
    });

    await expect(result.current.preloadModel()).rejects.toThrow(/clientInference/);
  });

  it('POSITIVE CONTROL — audio.clientInference.allow: true opens the gate and the model path runs', async () => {
    const embedder = fakeEmbedder();
    const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder }), { wrapper: wrapperFor(storeWith(ALLOWED)) });

    expect(result.current.supported).toBe(true);

    await act(async () => {
      await result.current.enroll(audioFile(), { label: 'Doc Mic' });
    });

    expect(embedder.load).toHaveBeenCalled();
    expect(embedder.embedBlob).toHaveBeenCalledTimes(1);
    expect(mockBackendEnroll).toHaveBeenCalledTimes(1);
    expect(result.current.enrolled).toHaveLength(1);
  });
});

describe('@arcaai/vox/plugins raw re-exports — the same allow applies', () => {
  it('useVAD never hands the track to the real hook, and attach() rejects with the typed code', async () => {
    const { result } = renderHook(() => useVAD({ track }), { wrapper: wrapperFor(storeWith()) });

    expect(rawUseVAD).toHaveBeenCalled();
    const [passed] = lastCall(rawUseVAD) as [{ track: unknown; autoAttach: boolean }];
    expect(passed.track).toBeNull();
    expect(passed.autoAttach).toBe(false);

    await expect(result.current.attach()).rejects.toMatchObject({ code: 'CLIENT_INFERENCE_DISABLED' });
    expect(track.setProcessor).not.toHaveBeenCalled();
  });

  it('useNoiseFilter is neutered the same way', async () => {
    const { result } = renderHook(() => useNoiseFilter({ track }), { wrapper: wrapperFor(storeWith()) });

    const [passed] = lastCall(rawUseNoiseFilter) as [{ track: unknown; autoAttach: boolean }];
    expect(passed.track).toBeNull();
    expect(passed.autoAttach).toBe(false);
    await expect(result.current.attach()).rejects.toMatchObject({ code: 'CLIENT_INFERENCE_DISABLED' });
  });

  it('CAPTURE-ONLY IS UNAFFECTED — useSTT on the default (remote) provider passes the track straight through', () => {
    renderHook(() => useSTT({ track }), { wrapper: wrapperFor(storeWith()) });

    const [passed] = lastCall(rawUseSTT) as [{ track: unknown; autoAttach?: boolean }];
    expect(passed.track).toBe(track);
    expect(passed.autoAttach).toBeUndefined();
  });

  it('useSTT with the in-browser provider IS gated', async () => {
    const { result } = renderHook(() => useSTT({ track, features: { provider: 'local' } }), { wrapper: wrapperFor(storeWith()) });

    const [passed] = lastCall(rawUseSTT) as [{ track: unknown; autoAttach: boolean }];
    expect(passed.track).toBeNull();
    expect(passed.autoAttach).toBe(false);
    await expect(result.current.attach()).rejects.toMatchObject({ code: 'CLIENT_INFERENCE_DISABLED' });
    await expect(result.current.transcribeSegment(new Float32Array(4))).rejects.toMatchObject({
      code: 'CLIENT_INFERENCE_DISABLED',
    });
  });

  it('fails CLOSED outside an AgenticProvider — no host config means no allow', async () => {
    const { result } = renderHook(() => useVAD({ track }));

    const [passed] = lastCall(rawUseVAD) as [{ track: unknown }];
    expect(passed.track).toBeNull();
    await expect(result.current.attach()).rejects.toBeInstanceOf(AgenticError);
  });

  it('POSITIVE CONTROL — with the allow, all three reach the real hook untouched', () => {
    const wrapper = wrapperFor(storeWith(ALLOWED));

    renderHook(() => useVAD({ track, autoAttach: true }), { wrapper });
    renderHook(() => useNoiseFilter({ track }), { wrapper });
    renderHook(() => useSTT({ track, features: { provider: 'local' } }), { wrapper });

    expect((lastCall(rawUseVAD) as [{ track: unknown; autoAttach: boolean }])[0]).toMatchObject({
      track,
      autoAttach: true,
    });
    expect((lastCall(rawUseNoiseFilter) as [{ track: unknown }])[0].track).toBe(track);
    expect((lastCall(rawUseSTT) as [{ track: unknown; features: { provider: string } }])[0]).toMatchObject({
      track,
      features: { provider: 'local' },
    });
  });

  it('the gated wrapper is what @arcaai/vox/plugins actually exports', async () => {
    const plugins = await import('../plugins.js');
    const gated = await import('../hooks/useGatedClientStages.js');

    expect(plugins.useVAD).toBe(gated.useVAD);
    expect(plugins.useSTT).toBe(gated.useSTT);
    expect(plugins.useNoiseFilter).toBe(gated.useNoiseFilter);
  });
});
