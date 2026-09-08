/**
 * compat `useAudioCapture` — `sttAgentSlug` forwarding (TASK-931).
 *
 * `V1SdkConfig` gained `sttAgentSlug` when the ASR Agent replaced the pipeline, and
 * `mapV1ConfigToV2` has preferred it over `sttPipelineId` since. This hook did not: it read
 * `options.sttPipelineId` and nothing else, so a compat app that moved its PROVIDER config to
 * the agent slug and also drove capture from here — which the playground does, because whichever
 * hook calls `audio.start()` first wins the shared-audio race — silently started a session with
 * no selector at all and ran the tenant default.
 *
 * The same precedence as the adapter, for the same reason: the session body carries at most one
 * selector, and `agentSlug` is the one that is not deprecated.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAudioCapture } from '../useAudioCapture';
import { useArcaAudio } from '../../hooks/useArcaAudio';
import { useAgenticStore } from '../../store/agenticStore';

vi.mock('../../hooks/useArcaAudio', () => ({ useArcaAudio: vi.fn() }));
vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('useAudioCapture — sttAgentSlug', () => {
  let audioMock: { isCapturing: boolean; level: number; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    audioMock = { isCapturing: false, level: 0, start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
    const storeState = { pendingSttProvider: null, setPendingSttProvider: vi.fn() };
    (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: typeof storeState) => unknown) =>
      selector(storeState),
    );
  });

  async function startWith(options: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { result } = renderHook(() => useAudioCapture({ options }));
    await act(async () => {
      await result.current.startRecording();
    });
    return audioMock.start.mock.calls[0][0] as Record<string, unknown>;
  }

  it('forwards sttAgentSlug as `agentSlug`', async () => {
    expect(await startWith({ sttAgentSlug: 'clinic-asr' })).toEqual({ agentSlug: 'clinic-asr' });
  });

  it('prefers the agent slug over the deprecated pipeline id — one selector on the wire, never both', async () => {
    expect(await startWith({ sttAgentSlug: 'clinic-asr', sttPipelineId: 'p1' })).toEqual({ agentSlug: 'clinic-asr' });
  });

  it('still forwards a lone sttPipelineId — the deprecated key keeps working until R4', async () => {
    expect(await startWith({ sttPipelineId: 'p1' })).toEqual({ pipelineId: 'p1' });
  });

  it('sends NEITHER key when neither is set, so the tenant assignment decides', async () => {
    expect(await startWith({})).toEqual({});
  });
});
