/**
 * `useSelectableAsrAgents`, the transcription-agent picker's data source (TASK-865).
 *
 * Mirrors `useSelectableConsultationWorkflows`: the read FAILS OPEN (a picker must
 * never break a capture screen) but never fails INVENTIVE — `null` ("we could not
 * ask") stays distinct from `[]` ("the tenant has published no ASR agent, the
 * platform default governs"). Backed by the TASK-863 business route
 * `GET /agents?task=SPEECH_TO_TEXT`, which answers from the same predicate the
 * stream-session route resolves `agentSlug` with, so nothing listed here is
 * refused at `audio.start({ agentSlug })`.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSelectableAsrAgents } from '../useSelectableAsrAgents';
import type { SelectableAsrAgent } from '../../types/agent';

const get = vi.fn();

vi.mock('../useApiOperation', () => ({
  useApiOperation: () => ({
    execute: async <T>(_name: string, fn: (client: { get: typeof get }) => Promise<T>) => fn({ get }),
    isLoading: false,
    error: null,
  }),
}));

const AGENTS: SelectableAsrAgent[] = [
  { slug: 'clinic-asr', name: 'Clinic ASR', description: 'Whisper large, server VAD', task: 'SPEECH_TO_TEXT', versionNumber: 3, isTenantDefault: true },
  { slug: 'fast-draft-asr', name: 'Fast Draft', description: null, task: 'SPEECH_TO_TEXT', versionNumber: 1, isTenantDefault: false },
];

describe('useSelectableAsrAgents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the tenant selectable set from GET /agents?task=SPEECH_TO_TEXT', async () => {
    get.mockResolvedValue({ data: AGENTS });
    const { result } = renderHook(() => useSelectableAsrAgents());

    await waitFor(() => expect(result.current.agents).toEqual(AGENTS));
    expect(get).toHaveBeenCalledWith('/agents?task=SPEECH_TO_TEXT');
  });

  it('surfaces the tenant default so a picker can preselect it', async () => {
    get.mockResolvedValue({ data: AGENTS });
    const { result } = renderHook(() => useSelectableAsrAgents());

    await waitFor(() => expect(result.current.agents).not.toBeNull());
    expect(result.current.tenantDefault?.slug).toBe('clinic-asr');
  });

  it('reports no default when the tenant has assigned nothing selectable', async () => {
    get.mockResolvedValue({ data: [{ ...AGENTS[1] }] });
    const { result } = renderHook(() => useSelectableAsrAgents());

    await waitFor(() => expect(result.current.agents).not.toBeNull());
    expect(result.current.tenantDefault).toBeNull();
  });

  it('keeps "the tenant published none" as a real, EMPTY answer', async () => {
    get.mockResolvedValue({ data: [] });
    const { result } = renderHook(() => useSelectableAsrAgents());

    await waitFor(() => expect(result.current.agents).toEqual([]));
    expect(result.current.tenantDefault).toBeNull();
  });

  it('FAILS OPEN to null — never rejecting, and never claiming the tenant has none', async () => {
    get.mockRejectedValue(new Error('gateway unreachable'));
    const { result } = renderHook(() => useSelectableAsrAgents());

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(result.current.agents).toBeNull();
    expect(result.current.agents).not.toEqual([]);
    await expect(result.current.refresh()).resolves.toBeNull();
  });

  it('tolerates a malformed payload rather than handing a non-array to a picker', async () => {
    get.mockResolvedValue({});
    const { result } = renderHook(() => useSelectableAsrAgents());

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(result.current.agents).toBeNull();
  });

  it('drops rows of another task the gateway might echo — the picker is for ASR only', async () => {
    get.mockResolvedValue({ data: [...AGENTS, { slug: 'note-llm', name: 'Note LLM', description: null, task: 'TEXT_GENERATION', versionNumber: 2, isTenantDefault: false }] });
    const { result } = renderHook(() => useSelectableAsrAgents());

    await waitFor(() => expect(result.current.agents).not.toBeNull());
    expect(result.current.agents?.map((agent) => agent.slug)).toEqual(['clinic-asr', 'fast-draft-asr']);
  });
});
