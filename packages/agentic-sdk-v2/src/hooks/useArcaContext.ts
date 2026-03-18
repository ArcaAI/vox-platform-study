/**
 * @arcaai/vox - useArcaContext Hook (REFACTOR-01)
 *
 * Focused hook for context item management (case notes, transcriptions, entities).
 * Extracted from the useArca god hook for better performance and maintainability.
 */

import { useMemo, useCallback } from 'react';
import {
  useAgenticStore,
  selectTranscriptions,
  selectCaseNotes,
} from '../store';
import type {
  ContextItem,
  MedicalEntity,
  ContextVersionEntry,
} from '../types';
import {
  CONTEXT_ENDPOINTS,
  SUMMARY_ENDPOINTS,
  ENTITY_ENDPOINTS,
} from '../core/constants';
import type { ISDKLogger } from '../core/logger';

export type { UseArcaContext } from './useArca';

export function useArcaContext() {
  const store = useAgenticStore();

  const getLogger = useCallback((): ISDKLogger | undefined => {
    return store.logger?.child('useArcaContext');
  }, [store.logger]);

  const addCaseNote = useCallback(
    async (content: string, metadata?: Record<string, unknown>): Promise<ContextItem> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('addCaseNote', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
      });

      store.setContextLoading(true);
      store.setContextError(null);

      try {
        const item = await apiClient.post<ContextItem>(
          CONTEXT_ENDPOINTS.ADD(consultation.id),
          { type: 'CASE_NOTE', content, source: 'USER', structuredData: metadata }
        );
        store.addContextItem(item);
        timer?.end(true, { attributes: { contextItemId: item.id, contentLength: content.length } });
        return item;
      } catch (error) {
        timer?.error(error as Error);
        store.setContextError(error as Error);
        throw error;
      } finally {
        store.setContextLoading(false);
      }
    },
    [store, getLogger]
  );

  const addTranscription = useCallback(
    async (text: string, metadata?: Record<string, unknown>): Promise<ContextItem> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('addTranscription', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
      });

      store.setContextLoading(true);
      store.setContextError(null);

      try {
        const item = await apiClient.post<ContextItem>(
          CONTEXT_ENDPOINTS.ADD(consultation.id),
          { type: 'TRANSCRIPT', content: text, source: 'TRANSCRIPTION', structuredData: metadata }
        );
        store.addContextItem(item);
        timer?.end(true, { attributes: { contextItemId: item.id, textLength: text.length } });
        return item;
      } catch (error) {
        timer?.error(error as Error);
        store.setContextError(error as Error);
        throw error;
      } finally {
        store.setContextLoading(false);
      }
    },
    [store, getLogger]
  );

  const updateItem = useCallback(
    async (id: string, content: string): Promise<void> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('updateContextItem', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId: id },
      });

      store.setContextLoading(true);
      store.setContextError(null);

      try {
        await apiClient.patch(CONTEXT_ENDPOINTS.UPDATE(consultation.id, id), { content });
        store.updateContextItem(id, { content });
        timer?.end(true, { attributes: { contentLength: content.length } });
      } catch (error) {
        timer?.error(error as Error);
        store.setContextError(error as Error);
        throw error;
      } finally {
        store.setContextLoading(false);
      }
    },
    [store, getLogger]
  );

  const loadSharedContext = useCallback(async (): Promise<ContextItem[]> => {
    const { apiClient, consultation } = store;
    const logger = getLogger();
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    const timer = logger?.startOperation('loadSharedContext', {
      component: 'useArcaContext',
      sdk: { consultationId: consultation.id },
    });

    store.setContextLoading(true);
    store.setContextError(null);

    try {
      const items = await apiClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.SHARED(consultation.id));
      store.setSharedContext(items);
      timer?.end(true, { attributes: { itemCount: items.length } });
      return items;
    } catch (error) {
      timer?.error(error as Error);
      store.setContextError(error as Error);
      throw error;
    } finally {
      store.setContextLoading(false);
    }
  }, [store, getLogger]);

  const extractEntities = useCallback(
    async (contextItemId?: string): Promise<MedicalEntity[]> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('extractEntities', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId: contextItemId || 'all' },
      });

      store.setContextLoading(true);
      store.setContextError(null);

      try {
        const endpoint = contextItemId
          ? ENTITY_ENDPOINTS.GET_FOR_ITEM(consultation.id, contextItemId)
          : ENTITY_ENDPOINTS.GET_ALL(consultation.id);

        const data = await apiClient.get<{ entities: MedicalEntity[] }>(endpoint);
        store.setEntities(data.entities);
        timer?.end(true, { attributes: { entityCount: data.entities.length } });
        return data.entities;
      } catch (error) {
        timer?.error(error as Error);
        store.setContextError(error as Error);
        throw error;
      } finally {
        store.setContextLoading(false);
      }
    },
    [store, getLogger]
  );

  const getContextVersions = useCallback(
    async (contextItemId: string): Promise<ContextVersionEntry[]> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('getContextVersions', {
        component: 'useArcaContext',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId },
      });

      try {
        const versions = await apiClient.get<ContextVersionEntry[]>(
          CONTEXT_ENDPOINTS.VERSIONS(consultation.id, contextItemId)
        );
        timer?.end(true, { attributes: { versionCount: versions.length } });
        return versions;
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [store, getLogger]
  );

  const triggerEntityExtraction = useCallback(
    async (contextItemId: string): Promise<void> => {
      const { apiClient, consultation } = store;
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
    [store, getLogger]
  );

  const fetchTranscriptions = useCallback(async (): Promise<ContextItem[]> => {
    const { apiClient, consultation } = store;
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    return apiClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.TRANSCRIPTIONS(consultation.id));
  }, [store]);

  const fetchCaseNotes = useCallback(async (): Promise<ContextItem[]> => {
    const { apiClient, consultation } = store;
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    return apiClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.CASE_NOTES(consultation.id));
  }, [store]);

  const transcriptions = useMemo(() => selectTranscriptions(store), [store.contextItems]);
  const caseNotes = useMemo(() => selectCaseNotes(store), [store.contextItems]);

  return useMemo(
    () => ({
      items: store.contextItems,
      transcriptions,
      caseNotes,
      entities: store.entities,
      sharedContext: store.sharedContext,
      isLoading: store.contextLoading,
      error: store.contextError,
      addCaseNote,
      addTranscription,
      updateItem,
      loadSharedContext,
      extractEntities,
      getContextVersions,
      triggerEntityExtraction,
      fetchTranscriptions,
      fetchCaseNotes,
    }),
    [
      store.contextItems, transcriptions, caseNotes, store.entities,
      store.sharedContext, store.contextLoading, store.contextError,
      addCaseNote, addTranscription, updateItem, loadSharedContext,
      extractEntities, getContextVersions, triggerEntityExtraction,
      fetchTranscriptions, fetchCaseNotes,
    ]
  );
}
