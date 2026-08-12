/**
 * Upload -> attach -> context-item `mediaId` round trip (TASK-671).
 *
 * TASK-656 fixed the SERVER so `StorageController.uploadFile` creates a
 * `Media` row and returns its id (`mediaId`) alongside the raw storage `key`.
 * TASK-665 threaded that id through the SDK client: `StorageFile.mediaId`
 * (`useStorage.ts`), `AddContextInput`/`ContextItem.mediaId`
 * (`types/context.ts`), and `addAttachment`'s third parameter
 * (`useArcaContext.ts`). No test proved the two hooks compose correctly end
 * to end — this closes that loop: `useStorage().uploadFile()` resolves a
 * `mediaId`, `useArcaContext().addAttachment()` forwards it on the POST body,
 * and the resulting `ContextItem` carries it back. This is exactly the bug
 * that silently broke every attachment's presigned URL (a caller persisting
 * the raw storage `key` instead of `mediaId`, which `MediaRepository.findById`
 * cannot resolve) — proving the round trip end to end in the SDK guards
 * against it recurring.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStorage } from '../useStorage';
import { useArcaContext } from '../useArcaContext';

const apiClient = {
  post: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  postFormData: vi.fn(),
};

const mockStore: Record<string, unknown> = {
  apiClient,
  logger: null,
  consultation: { id: 'consult-1' },
  contextItems: [] as unknown[],
  entities: [] as unknown[],
  sharedContext: [] as unknown[],
  contextLoading: false,
  contextError: null,
  setContextLoading: vi.fn(),
  setContextError: vi.fn(),
  addContextItem: vi.fn(),
  updateContextItem: vi.fn(),
  setSharedContext: vi.fn(),
  setEntities: vi.fn(),
};

vi.mock('../../store', () => ({
  useAgenticStore: vi.fn((selector?: (s: unknown) => unknown) => (typeof selector === 'function' ? selector(mockStore) : mockStore)),
  selectApiClient: (s: { apiClient: unknown }) => s.apiClient,
  selectConsultation: (s: { consultation: unknown }) => s.consultation,
  selectContextItems: (s: { contextItems: unknown[] }) => s.contextItems,
  selectSharedContext: (s: { sharedContext: unknown[] }) => s.sharedContext,
  selectEntities: (s: { entities: unknown[] }) => s.entities,
  selectContextLoading: (s: { contextLoading: boolean }) => s.contextLoading,
  selectContextError: (s: { contextError: unknown }) => s.contextError,
  selectLogger: (s: { logger: unknown }) => s.logger,
  selectTranscriptions: (s: { contextItems: { type?: string }[] }) => s.contextItems.filter((i) => i.type === 'TRANSCRIPT'),
  selectCaseNotes: (s: { contextItems: { type?: string }[] }) => s.contextItems.filter((i) => i.type === 'CASE_NOTE'),
  selectWorknotes: (s: { contextItems: { type?: string }[] }) => s.contextItems.filter((i) => i.type === 'WORKNOTE'),
  selectAttachments: (s: { contextItems: { type?: string }[] }) => s.contextItems.filter((i) => i.type === 'ATTACHMENT'),
}));

describe('upload -> attach -> context-item mediaId round trip (TASK-671)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.contextItems = [];
  });

  it('threads mediaId from useStorage().uploadFile() through useArcaContext().addAttachment() to the returned ContextItem', async () => {
    apiClient.postFormData.mockResolvedValue({
      key: 'consult-1/lab-result.pdf',
      mediaId: 'media-round-trip-1',
    });
    apiClient.post.mockResolvedValue({
      id: 'ctx-attach-1',
      type: 'ATTACHMENT',
      mediaId: 'media-round-trip-1',
    });

    const { result: storageResult } = renderHook(() => useStorage());
    const { result: contextResult } = renderHook(() => useArcaContext());

    // Step 1: upload a file — the server (TASK-656) returns `mediaId`
    // alongside the raw storage `key`.
    let uploaded: { key: string; mediaId?: string } | undefined;
    await act(async () => {
      uploaded = await storageResult.current.uploadFile('lab-results', new File(['x'], 'lab-result.pdf'));
    });
    expect(uploaded?.mediaId).toBe('media-round-trip-1');
    // The raw storage key is NOT what gets persisted as the context
    // reference — asserting it differs guards against the exact regression
    // this test exists to prevent (persisting `key` instead of `mediaId`).
    expect(uploaded?.mediaId).not.toBe(uploaded?.key);

    // Step 2: attach it, forwarding the uploaded mediaId (not the key).
    let attached: { id: string; mediaId?: string } | undefined;
    await act(async () => {
      attached = await contextResult.current.addAttachment('lab result scan', undefined, uploaded?.mediaId);
    });

    // The POST to add the context item carried the uploaded mediaId.
    expect(apiClient.post).toHaveBeenCalledWith(
      '/consultations/consult-1/context',
      expect.objectContaining({ type: 'ATTACHMENT', mediaId: 'media-round-trip-1' }),
    );
    // Step 3: the round trip closes — the returned (and store-persisted)
    // ContextItem carries the SAME mediaId the upload produced.
    expect(attached?.mediaId).toBe('media-round-trip-1');
    expect(mockStore.addContextItem).toHaveBeenCalledWith(expect.objectContaining({ mediaId: 'media-round-trip-1' }));
  });
});
