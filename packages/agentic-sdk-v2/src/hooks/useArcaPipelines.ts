/**
 * @arcaai/vox - useArcaPipelines Hook (REFACTOR-01)
 *
 * Focused hook for pipeline control (pause/resume, NER, summarization).
 * Extracted from the useArca god hook for better performance and maintainability.
 */

import { useMemo, useCallback } from 'react';
import { useAgenticStore, selectTranscriptionPipelineState, selectKnowledgePipelineState } from '../store';
import type { MedicalEntity, PipelineStateInfo } from '../types';
import type { ISDKLogger } from '../core/logger';

// =============================================================================
// Return Type
// =============================================================================

/**
 * Pipeline control interface returned by useArcaPipelines
 */
export interface UseArcaPipelineControl {
  /** Transcription pipeline state */
  transcription: PipelineStateInfo | null;
  /** Knowledge pipeline state */
  knowledge: PipelineStateInfo | null;
  /** Pause transcription pipeline */
  pauseTranscription: () => void;
  /** Resume transcription pipeline */
  resumeTranscription: () => void;
  /** Trigger NER manually */
  triggerNER: (text?: string) => Promise<MedicalEntity[]>;
  /** Trigger summarization manually */
  triggerSummarization: () => Promise<string>;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for pipeline control (pause/resume transcription, trigger NER, trigger summarization).
 *
 * Extracted from useArca for better performance and maintainability (REFACTOR-01).
 */
export function useArcaPipelines(): UseArcaPipelineControl {
  const store = useAgenticStore();

  const getLogger = useCallback((): ISDKLogger | undefined => {
    return store.logger?.child('useArcaPipelines');
  }, [store.logger]);

  // ==========================================================================
  // Pipeline Actions
  // ==========================================================================

  const pauseTranscription = useCallback(() => {
    const { pluginManager } = store;
    const logger = getLogger();

    const pipeline = pluginManager?.getTranscriptionPipeline();
    if (pipeline) {
      pipeline.pause();
      logger?.debug('Transcription pipeline paused', {
        operation: 'pauseTranscription',
        component: 'useArcaPipelines',
      });
    }
  }, [store, getLogger]);

  const resumeTranscription = useCallback(() => {
    const { pluginManager } = store;
    const logger = getLogger();

    const pipeline = pluginManager?.getTranscriptionPipeline();
    if (pipeline) {
      pipeline.resume();
      logger?.debug('Transcription pipeline resumed', {
        operation: 'resumeTranscription',
        component: 'useArcaPipelines',
      });
    }
  }, [store, getLogger]);

  const triggerNER = useCallback(
    async (text?: string): Promise<MedicalEntity[]> => {
      const { pluginManager } = store;
      const logger = getLogger();

      const timer = logger?.startOperation('triggerNER', {
        component: 'useArcaPipelines',
      });

      try {
        const pipeline = pluginManager?.getKnowledgePipeline();
        if (!pipeline) {
          throw new Error('Knowledge pipeline not initialized');
        }

        const entities = await pipeline.triggerNER(text);

        // Add to store
        store.addEntities(entities);

        timer?.end(true, { attributes: { entityCount: entities.length } });
        logger?.info('NER triggered manually', {
          operation: 'triggerNER',
          component: 'useArcaPipelines',
          success: true,
          attributes: { entityCount: entities.length },
        });

        return entities;
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

  const triggerSummarization = useCallback(async (): Promise<string> => {
    const { pluginManager, consultation } = store;
    const logger = getLogger();

    if (!consultation) {
      throw new Error('No active consultation');
    }

    const timer = logger?.startOperation('triggerSummarization', {
      component: 'useArcaPipelines',
      sdk: { consultationId: consultation.id },
    });

    try {
      const pipeline = pluginManager?.getKnowledgePipeline();
      if (!pipeline) {
        throw new Error('Knowledge pipeline not initialized');
      }

      const summary = await pipeline.triggerSummarization(consultation.id);

      timer?.end(true, { attributes: { summaryLength: summary.length } });
      logger?.info('Summarization triggered manually', {
        operation: 'triggerSummarization',
        component: 'useArcaPipelines',
        success: true,
        sdk: { consultationId: consultation.id },
      });

      return summary;
    } catch (error) {
      timer?.error(error as Error);
      throw error;
    }
  }, [store, getLogger]);

  // ==========================================================================
  // Memoized Returns
  // ==========================================================================

  const transcriptionPipelineState = selectTranscriptionPipelineState(store);
  const knowledgePipelineState = selectKnowledgePipelineState(store);

  return useMemo<UseArcaPipelineControl>(
    () => ({
      transcription: transcriptionPipelineState,
      knowledge: knowledgePipelineState,
      pauseTranscription,
      resumeTranscription,
      triggerNER,
      triggerSummarization,
    }),
    [transcriptionPipelineState, knowledgePipelineState, pauseTranscription, resumeTranscription, triggerNER, triggerSummarization],
  );
}
