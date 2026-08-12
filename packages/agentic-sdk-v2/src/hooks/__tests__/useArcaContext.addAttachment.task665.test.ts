/**
 * useArcaContext — `addAttachment` mediaId threading (TASK-665).
 *
 * TASK-656 gave `StorageFile` (`useStorage.ts`) a `mediaId` field on upload —
 * the `Media` table row id the backend can actually resolve, unlike the raw
 * storage `key`. This closes the other half: `addAttachment` accepts that id
 * and forwards it on the POST body, so a caller that just uploaded a file
 * can attach it without a second round trip.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaContext } from '../useArcaContext';
import { useAgenticStore } from '../../store';

const mockStore = {
  contextItems: [] as unknown[],
  entities: [] as unknown[],
  sharedContext: [] as unknown[],
  contextLoading: false,
  contextError: null,
  consultation: { id: 'consult-1' },
  apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
  logger: null,
  initialized: true,
  setContextLoading: vi.fn(),
  setContextError: vi.fn(),
  addContextItem: vi.fn(),
  updateContextItem: vi.fn(),
  setSharedContext: vi.fn(),
  setEntities: vi.fn(),
  addEntities: vi.fn(),
};

vi.mock('../../store', () => {
  return {
    useAgenticStore: vi.fn((selector?: (s: unknown) => unknown) => {
      if (typeof selector === 'function') return selector(mockStore);
      return mockStore;
    }),
    selectTranscriptions: (s: { contextItems: { type?: string }[] }) => s.contextItems.filter((i) => i.type === 'transcription'),
    selectCaseNotes: (s: { contextItems: { type?: string }[] }) => s.contextItems.filter((i) => i.type === 'case_note'),
    selectWorknotes: (s: { contextItems: { type?: string }[] }) => s.contextItems.filter((i) => i.type === 'WORKNOTE'),
    selectAttachments: (s: { contextItems: { type?: string }[] }) => s.contextItems.filter((i) => i.type === 'ATTACHMENT'),
    selectIsAudioSource: () => false,
    selectTranscriptionPipelineState: () => null,
    selectKnowledgePipelineState: () => null,
    selectConsultation: (s: { consultation: unknown }) => s.consultation,
    selectIsCapturing: () => false,
    selectAudioLevel: () => 0,
    selectEntities: (s: { entities: unknown[] }) => s.entities,
    selectSummaries: () => [],
    selectApiClient: (s: { apiClient: unknown }) => s.apiClient,
    selectContextItems: (s: { contextItems: unknown[] }) => s.contextItems,
    selectSharedContext: (s: { sharedContext: unknown[] }) => s.sharedContext,
    selectContextLoading: (s: { contextLoading: boolean }) => s.contextLoading,
    selectContextError: (s: { contextError: unknown }) => s.contextError,
    selectLogger: (s: { logger: unknown }) => s.logger,
  };
});

describe('useArcaContext — addAttachment mediaId threading (TASK-665)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockStore.apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ctx-attach-1', type: 'ATTACHMENT' });
  });

  it('forwards mediaId on the POST body when supplied', async () => {
    const { result } = renderHook(() => useArcaContext());

    await act(async () => {
      await result.current.addAttachment('a scanned lab result', { subType: 'LAB_RESULT' }, 'media-abc-123');
    });

    expect(mockStore.apiClient.post).toHaveBeenCalledWith(
      '/consultations/consult-1/context',
      expect.objectContaining({
        type: 'ATTACHMENT',
        content: 'a scanned lab result',
        mediaId: 'media-abc-123',
      }),
    );
  });

  it('omits mediaId (undefined) when the caller does not supply one — back-compat', async () => {
    const { result } = renderHook(() => useArcaContext());

    await act(async () => {
      await result.current.addAttachment('no upload, text only');
    });

    expect(mockStore.apiClient.post).toHaveBeenCalledWith(
      '/consultations/consult-1/context',
      expect.objectContaining({
        type: 'ATTACHMENT',
        content: 'no upload, text only',
        mediaId: undefined,
      }),
    );
  });
});
