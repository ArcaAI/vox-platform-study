/**
 * @arcaai/vox - useArcaContext Hook (REFACTOR-01)
 *
 * Focused hook for context item management (case notes, transcriptions, entities).
 * Extracted from the useArca god hook for better performance and maintainability.
 *
 * Replaces `const store = useAgenticStore();` with discrete
 * selector subscriptions so only the slices this hook reads can re-render it.
 * Zustand action dispatchers (e.g. `addContextItem`, `setContextLoading`) are
 * selected individually too; they are stable references.
 */

import { useMemo, useCallback } from 'react';
import {
  useAgenticStore,
  selectApiClient,
  selectConsultation,
  selectContextItems,
  selectSharedContext,
  selectEntities,
  selectContextLoading,
  selectContextError,
  selectLogger,
  selectTranscriptions,
  selectCaseNotes,
  selectWorknotes,
  selectAttachments,
} from '../store';
import type { ContextItem, ContextFilters, MedicalEntity, ContextVersionEntry } from '../types';
import { CONTEXT_ENDPOINTS, SUMMARY_ENDPOINTS, ENTITY_ENDPOINTS } from '../core/constants';
import type { ISDKLogger } from '../core/logger';

export type { UseArcaContext } from './useArca';

export function useArcaContext() {
  // Slice selectors.
  const apiClient = useAgenticStore(selectApiClient);
  const consultation = useAgenticStore(selectConsultation);
  const contextItems = useAgenticStore(selectContextItems);
  const sharedContext = useAgenticStore(selectSharedContext);
  const entities = useAgenticStore(selectEntities);
  const contextLoading = useAgenticStore(selectContextLoading);
  const contextError = useAgenticStore(selectContextError);
  const sdkLogger = useAgenticStore(selectLogger);

  // Action selectors. Zustand keeps action references stable across renders
  // so no extra `useShallow` is needed for any individual one.
  const addContextItem = useAgenticStore((s) => s.addContextItem);
  const updateContextItemAction = useAgenticStore((s) => s.updateContextItem);
  const setSharedContextAction = useAgenticStore((s) => s.setSharedContext);
  const setEntitiesAction = useAgenticStore((s) => s.setEntities);
  const setContextLoading = useAgenticStore((s) => s.setContextLoading);
  const setContextError = useAgenticStore((s) => s.setContextError);

  const getLogger = useCallback((): ISDKLogger | undefined => {
    return sdkLogger?.child('useArcaContext');
  }, [sdkLogger]);

  const addCaseNote = useCallback(
    async (content: string, metadata?: Record<string, unknown>): Promise<ContextItem> => {
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('addCaseNote', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
      });

      setContextLoading(true);
      setContextError(null);

      try {
        const item = await apiClient.post<ContextItem>(CONTEXT_ENDPOINTS.ADD(consultation.id), {
          type: 'CASE_NOTE',
          content,
          source: 'USER',
          metadata,
        });
        addContextItem(item);
        timer?.end(true, { attributes: { contextItemId: item.id, contentLength: content.length } });
        return item;
      } catch (error) {
        timer?.error(error as Error);
        setContextError(error as Error);
        throw error;
      } finally {
        setContextLoading(false);
      }
    },
    [apiClient, consultation, addContextItem, setContextLoading, setContextError, getLogger],
  );

  const addTranscription = useCallback(
    async (text: string, metadata?: Record<string, unknown>): Promise<ContextItem> => {
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('addTranscription', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
      });

      setContextLoading(true);
      setContextError(null);

      try {
        const item = await apiClient.post<ContextItem>(CONTEXT_ENDPOINTS.ADD(consultation.id), {
          type: 'TRANSCRIPT',
          content: text,
          source: 'TRANSCRIPTION',
          metadata,
        });
        addContextItem(item);
        timer?.end(true, { attributes: { contextItemId: item.id, textLength: text.length } });
        return item;
      } catch (error) {
        timer?.error(error as Error);
        setContextError(error as Error);
        throw error;
      } finally {
        setContextLoading(false);
      }
    },
    [apiClient, consultation, addContextItem, setContextLoading, setContextError, getLogger],
  );

  const addWorknote = useCallback(
    async (content: string, metadata?: Record<string, unknown>): Promise<ContextItem> => {
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('addWorknote', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
      });

      setContextLoading(true);
      setContextError(null);

      try {
        const item = await apiClient.post<ContextItem>(CONTEXT_ENDPOINTS.ADD(consultation.id), {
          type: 'WORKNOTE',
          content,
          source: 'USER',
          metadata,
        });
        addContextItem(item);
        timer?.end(true, { attributes: { contextItemId: item.id, contentLength: content.length } });
        return item;
      } catch (error) {
        timer?.error(error as Error);
        setContextError(error as Error);
        throw error;
      } finally {
        setContextLoading(false);
      }
    },
    [apiClient, consultation, addContextItem, setContextLoading, setContextError, getLogger],
  );

  const addAttachment = useCallback(
    async (content?: string, metadata?: Record<string, unknown>, mediaId?: string): Promise<ContextItem> => {
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('addAttachment', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
      });

      setContextLoading(true);
      setContextError(null);

      try {
        const item = await apiClient.post<ContextItem>(CONTEXT_ENDPOINTS.ADD(consultation.id), {
          type: 'ATTACHMENT',
          content: content ?? '',
          source: 'USER',
          metadata,
          // TASK-656/665: the `Media` table row UUID from `useStorage().uploadFile()`
          // — the id the backend can actually resolve, unlike the raw storage `key`.
          mediaId,
        });
        addContextItem(item);
        timer?.end(true, { attributes: { contextItemId: item.id, contentLength: (content ?? '').length, hasMediaId: !!mediaId } });
        return item;
      } catch (error) {
        timer?.error(error as Error);
        setContextError(error as Error);
        throw error;
      } finally {
        setContextLoading(false);
      }
    },
    [apiClient, consultation, addContextItem, setContextLoading, setContextError, getLogger],
  );

  const updateItem = useCallback(
    async (id: string, content: string): Promise<void> => {
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('updateContextItem', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId: id },
      });

      setContextLoading(true);
      setContextError(null);

      try {
        await apiClient.patch(CONTEXT_ENDPOINTS.UPDATE(consultation.id, id), { content });
        updateContextItemAction(id, { content });
        timer?.end(true, { attributes: { contentLength: content.length } });
      } catch (error) {
        timer?.error(error as Error);
        setContextError(error as Error);
        throw error;
      } finally {
        setContextLoading(false);
      }
    },
    [apiClient, consultation, updateContextItemAction, setContextLoading, setContextError, getLogger],
  );

  const getItems = useCallback(
    async (filters?: ContextFilters): Promise<ContextItem[]> => {
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('getItems', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
        attributes: { filters },
      });

      try {
        const params = new URLSearchParams();
        if (filters?.type) params.set('type', filters.type);
        if (filters?.source) params.set('source', filters.source);
        if (filters?.limit) params.set('limit', String(filters.limit));
        if (filters?.page) params.set('page', String(filters.page));

        const qs = params.toString();
        const url = CONTEXT_ENDPOINTS.GET(consultation.id) + (qs ? `?${qs}` : '');
        const items = await apiClient.get<ContextItem[]>(url);
        timer?.end(true, { attributes: { itemCount: items.length } });
        return items;
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [apiClient, consultation, getLogger],
  );

  const loadSharedContext = useCallback(async (): Promise<ContextItem[]> => {
    const logger = getLogger();
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    const timer = logger?.startOperation('loadSharedContext', {
      component: 'useArcaContext',
      sdk: { consultationId: consultation.id },
    });

    setContextLoading(true);
    setContextError(null);

    try {
      const items = await apiClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.SHARED(consultation.id));
      setSharedContextAction(items);
      timer?.end(true, { attributes: { itemCount: items.length } });
      return items;
    } catch (error) {
      timer?.error(error as Error);
      setContextError(error as Error);
      throw error;
    } finally {
      setContextLoading(false);
    }
  }, [apiClient, consultation, setSharedContextAction, setContextLoading, setContextError, getLogger]);

  const extractEntities = useCallback(
    async (contextItemId?: string): Promise<MedicalEntity[]> => {
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('extractEntities', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId: contextItemId || 'all' },
      });

      setContextLoading(true);
      setContextError(null);

      try {
        const endpoint = contextItemId ? ENTITY_ENDPOINTS.GET_FOR_ITEM(consultation.id, contextItemId) : ENTITY_ENDPOINTS.GET_ALL(consultation.id);

        const data = await apiClient.get<{ entities: MedicalEntity[] }>(endpoint);
        setEntitiesAction(data.entities);
        timer?.end(true, { attributes: { entityCount: data.entities.length } });
        return data.entities;
      } catch (error) {
        timer?.error(error as Error);
        setContextError(error as Error);
        throw error;
      } finally {
        setContextLoading(false);
      }
    },
    [apiClient, consultation, setEntitiesAction, setContextLoading, setContextError, getLogger],
  );

  const getContextVersions = useCallback(
    async (contextItemId: string): Promise<ContextVersionEntry[]> => {
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('getContextVersions', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId },
      });

      try {
        const versions = await apiClient.get<ContextVersionEntry[]>(CONTEXT_ENDPOINTS.VERSIONS(consultation.id, contextItemId));
        timer?.end(true, { attributes: { versionCount: versions.length } });
        return versions;
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [apiClient, consultation, getLogger],
  );

  const triggerEntityExtraction = useCallback(
    async (contextItemId: string): Promise<void> => {
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('triggerEntityExtraction', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId },
      });

      try {
        await apiClient.post(SUMMARY_ENDPOINTS.EXTRACT_ENTITIES(consultation.id, contextItemId), {});
        timer?.end(true);
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [apiClient, consultation, getLogger],
  );

  const fetchTranscriptions = useCallback(async (): Promise<ContextItem[]> => {
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    return apiClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.TRANSCRIPTIONS(consultation.id));
  }, [apiClient, consultation]);

  const fetchCaseNotes = useCallback(async (): Promise<ContextItem[]> => {
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    return apiClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.CASE_NOTES(consultation.id));
  }, [apiClient, consultation]);

  const fetchWorknotes = useCallback(async (): Promise<ContextItem[]> => {
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    return apiClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.WORKNOTES(consultation.id));
  }, [apiClient, consultation]);

  const fetchAttachments = useCallback(async (): Promise<ContextItem[]> => {
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    return apiClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.ATTACHMENTS(consultation.id));
  }, [apiClient, consultation]);

  const transcriptions = useMemo(
    () => selectTranscriptions({ contextItems } as unknown as Parameters<typeof selectTranscriptions>[0]),
    [contextItems],
  );
  const caseNotes = useMemo(() => selectCaseNotes({ contextItems } as unknown as Parameters<typeof selectCaseNotes>[0]), [contextItems]);
  const worknotes = useMemo(() => selectWorknotes({ contextItems } as unknown as Parameters<typeof selectWorknotes>[0]), [contextItems]);
  const attachments = useMemo(() => selectAttachments({ contextItems } as unknown as Parameters<typeof selectAttachments>[0]), [contextItems]);

  return useMemo(
    () => ({
      items: contextItems,
      transcriptions,
      caseNotes,
      worknotes,
      attachments,
      entities,
      sharedContext,
      isLoading: contextLoading,
      error: contextError,
      addCaseNote,
      addTranscription,
      addWorknote,
      addAttachment,
      updateItem,
      getItems,
      loadSharedContext,
      extractEntities,
      getContextVersions,
      triggerEntityExtraction,
      fetchTranscriptions,
      fetchCaseNotes,
      fetchWorknotes,
      fetchAttachments,
    }),
    [
      contextItems,
      transcriptions,
      caseNotes,
      worknotes,
      attachments,
      entities,
      sharedContext,
      contextLoading,
      contextError,
      addCaseNote,
      addTranscription,
      addWorknote,
      addAttachment,
      updateItem,
      getItems,
      loadSharedContext,
      extractEntities,
      getContextVersions,
      triggerEntityExtraction,
      fetchTranscriptions,
      fetchCaseNotes,
      fetchWorknotes,
      fetchAttachments,
    ],
  );
}
