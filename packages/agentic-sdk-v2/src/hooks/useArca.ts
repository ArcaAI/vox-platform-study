/**
 * @arcaai/vox - useArca Hook
 *
 * Unified hook for accessing all SDK functionality with comprehensive logging.
 */

import { useMemo, useCallback } from 'react';
import {
  useAgenticStore,
  selectTranscriptions,
  selectCaseNotes,
  selectIsAudioSource,
  selectTranscriptionPipelineState,
  selectKnowledgePipelineState,
} from '../store';
import type {
  Consultation,
  OpenSessionInput,
  ContextItem,
  ContextFilters,
  MedicalEntity,
  SummaryResponse,
  DNAStyle,
  AudioPluginStates,
  TranscriptionResult,
  PipelineStateInfo,
  AsyncJobResponse,
  ComprehensiveSummaryResponse,
  TimelineEntry,
  TimelineScope,
  ContextVersionEntry,
  PaginationParams,
  UpdateSummaryOptions,
  SummaryVersionEntry,
  DiffResult,
} from '../types';
import type { SummaryGenerationOptions } from '../types/summary';
import type { TranscriptSegment, AudioStartOptions } from '../types/audio';
import { CONSULTATION_ENDPOINTS, CONTEXT_ENDPOINTS, SUMMARY_ENDPOINTS, ENTITY_ENDPOINTS } from '../core/constants';
import { computeSummaryDiff } from '../utils/diffUtils';
import { withRetry as withRetryUtil, type RetryOptions } from '../utils/errorUtils';
import type { ISDKLogger } from '../core/logger';
import { openSessionOperation, loadConsultationOperation, getPatientHistoryOperation } from '../core/sessionUtils';

// =============================================================================
// Return Type
// =============================================================================

export interface ListConsultationsParams {
  page?: number;
  limit?: number;
  doctorId?: string;
  patientId?: string;
  departmentId?: string;
  hasSummary?: boolean;
}

export interface PaginatedConsultations {
  data: Consultation[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Session interface returned by useArca
 *
 * HOOK-01: Aligned with useArcaSession's get-or-create model.
 * Uses CONSULTATION_ENDPOINTS.OPEN (get-or-create) instead of
 * the old lifecycle model (CREATE, END, PAUSE, RESUME).
 */
export interface UseArcaSession {
  /** Current consultation (null if none open) */
  consultation: Consultation | null;
  /** Related consultations in the chain */
  relatedConsultations: Consultation[];
  /** Loading state */
  isLoading: boolean;
  /** Error if any */
  error: Error | null;
  /** Open a consultation session (get-or-create) */
  open: (input: OpenSessionInput) => Promise<Consultation>;
  /** Load a specific consultation by ID */
  load: (id: string) => Promise<Consultation>;
  /** Find consultations by patient and date */
  findByPatientDate: (patientId: string, date: string) => Promise<Consultation[]>;
  /** Get patient consultation history (SES-06: accepts optional pagination) */
  getPatientHistory: (patientId: string, pagination?: PaginationParams) => Promise<Consultation[]>;
  /** Get consultation timeline (SES-04). Supports scope='single'|'chain'. */
  getTimeline: (scope?: TimelineScope) => Promise<TimelineEntry[]>;
  /** List consultations with optional filters and pagination (WS-H) */
  listConsultations: (params?: ListConsultationsParams) => Promise<PaginatedConsultations>;
}

/**
 * Audio interface returned by useArca
 *
 * HOOK-05: Now includes toggleSTT and toggleVAD alongside toggleNoiseFilter.
 */
export interface UseArcaAudio {
  isCapturing: boolean;
  isMuted: boolean;
  level: number;
  isSpeaking: boolean;
  currentTranscript: string;
  transcriptSegments: TranscriptSegment[];
  language: string;
  plugins: AudioPluginStates;
  error: Error | null;
  start: (options?: AudioStartOptions) => Promise<void>;
  stop: () => Promise<void>;
  mute: () => void;
  unmute: () => void;
  toggleNoiseFilter: (enabled?: boolean) => void;
  /** Toggle STT on/off (ASR-L-01/HOOK-05) */
  toggleSTT: (enabled?: boolean) => Promise<void>;
  /** Toggle VAD on/off (ASR-L-01/HOOK-05) */
  toggleVAD: (enabled?: boolean) => Promise<void>;
}

/**
 * Context interface returned by useArca
 *
 * SES-07: Added fetchTranscriptions and fetchCaseNotes for dedicated backend fetches.
 */
export interface UseArcaContext {
  items: ContextItem[];
  transcriptions: ContextItem[];
  caseNotes: ContextItem[];
  entities: MedicalEntity[];
  sharedContext: ContextItem[];
  isLoading: boolean;
  error: Error | null;
  addCaseNote: (content: string, metadata?: Record<string, unknown>) => Promise<ContextItem>;
  addTranscription: (text: string, metadata?: Record<string, unknown>) => Promise<ContextItem>;
  updateItem: (id: string, content: string) => Promise<void>;
  /** Fetch all context items from backend with optional filters */
  getItems: (filters?: ContextFilters) => Promise<ContextItem[]>;
  loadSharedContext: () => Promise<ContextItem[]>;
  extractEntities: (contextItemId?: string) => Promise<MedicalEntity[]>;
  /** Get version history for a context item (SES-05) */
  getContextVersions: (contextItemId: string) => Promise<ContextVersionEntry[]>;
  /** Trigger backend NER entity extraction on a context item (NER-R-03) */
  triggerEntityExtraction: (contextItemId: string) => Promise<void>;
  /** Fetch transcriptions from backend (SES-07) */
  fetchTranscriptions: () => Promise<ContextItem[]>;
  /** Fetch case notes from backend (SES-07) */
  fetchCaseNotes: () => Promise<ContextItem[]>;
}

/**
 * Summary interface returned by useArca
 *
 * HOOK-06: Added loadSummaries to fetch existing summaries from backend.
 */
export interface UseArcaSummary {
  preSummary: SummaryResponse | null;
  summary: SummaryResponse | null;
  all: SummaryResponse[];
  dnaStyle: DNAStyle | null;
  isGenerating: boolean;
  error: Error | null;
  generatePreSummary: (options?: SummaryGenerationOptions) => Promise<SummaryResponse>;
  generateSummary: (options?: SummaryGenerationOptions) => Promise<SummaryResponse>;
  updateSummary: (id: string, content: string, options?: UpdateSummaryOptions) => Promise<void>;
  analyzeDNA: (texts: string[]) => Promise<DNAStyle>;
  /** Get version history for a summary (WS-5) */
  getSummaryHistory: (summaryId: string) => Promise<SummaryVersionEntry[]>;
  /** Compare two summary versions using word-level diff (WS-5) */
  compareSummaryVersions: (contextItemId: string, v1: number, v2: number) => Promise<DiffResult>;
  /** Fetch all summaries for the current consultation from backend (HOOK-06/SUM-04) */
  loadSummaries: (pagination?: PaginationParams) => Promise<SummaryResponse[]>;
  /** Generate summary asynchronously — returns job ID (SUM-01) */
  generateSummaryAsync: (options?: SummaryGenerationOptions) => Promise<AsyncJobResponse>;
  /** Generate pre-summary asynchronously (SUM-01) */
  generatePreSummaryAsync: (options?: SummaryGenerationOptions) => Promise<AsyncJobResponse>;
  /** Generate comprehensive (cross-chain) summary (SUM-02) */
  generateComprehensiveSummary: (options?: { dnaStyleId?: string; includeNER?: boolean }) => Promise<ComprehensiveSummaryResponse>;
  /** Get the latest pre-summary (SUM-03) */
  getLatestPreSummary: () => Promise<SummaryResponse>;
}

/**
 * Pipeline control interface
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

/**
 * Lifecycle interface returned by useArca (C-001).
 *
 * Provides tab-close safety checks, pending-operation tracking,
 * and graceful/force shutdown methods for cross-tab coordination.
 */
export interface UseArcaLifecycle {
  status: 'RUNNING' | 'PAUSED' | 'ERROR' | 'IDLE';
  canClose: boolean;
  pendingOperations: string[];
  state: {
    audioCapture: string;
    transcriptionPipeline: string;
    knowledgePipeline: string;
    hasUnsavedData: boolean;
  };
  requestGracefulShutdown: (opts?: { timeoutMs?: number }) => Promise<void>;
  forceShutdown: () => Promise<void>;
}

/**
 * Re-export RetryOptions from shared utility for interface compatibility.
 */
export type { RetryOptions } from '../utils/errorUtils';

/**
 * Return type for useArca hook
 */
export interface UseArcaReturn {
  session: UseArcaSession;
  audio: UseArcaAudio;
  context: UseArcaContext;
  summary: UseArcaSummary;
  /** Whether this tab is the audio source */
  isAudioSource: boolean;
  /** Pipeline control */
  pipelines: UseArcaPipelineControl;
  /** Lifecycle management for cross-tab coordination (C-001) */
  lifecycle: UseArcaLifecycle;
  isReady: boolean;
  error: Error | null;
  /** Retry wrapper for retriable API operations (HOOK-07) */
  withRetry: <T>(fn: () => Promise<T>, options?: RetryOptions) => Promise<T>;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Unified hook for ARCAAI Agentic SDK.
 *
 * Provides simplified access to all SDK capabilities:
 * - Session management
 * - Audio capture and processing
 * - Context management
 * - Summary generation
 *
 * @example
 * ```tsx
 * function ConsultationPage() {
 *   const { session, audio, context, summary, isReady, error } = useArca();
 *
 *   const handleStart = async () => {
 *     await session.create({
 *       patientId: 'patient-123',
 *       appointmentDate: '2026-01-12',
 *       doctorId: 'doctor-456',
 *     });
 *     await audio.start();
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleStart}>Start</button>
 *       <div>Level: {audio.level}%</div>
 *     </div>
 *   );
 * }
 * ```
 */
export function useArca(): UseArcaReturn {
  const store = useAgenticStore();

  // Get logger from store (create child for this hook)
  const getLogger = useCallback((): ISDKLogger | undefined => {
    return store.logger?.child('useArca');
  }, [store.logger]);

  // ==========================================================================
  // Session Actions
  // ==========================================================================

  /**
   * Open a consultation session (get-or-create).
   * Delegates core logic to shared sessionUtils (REFACTOR-02).
   */
  const openSession = useCallback(
    async (input: OpenSessionInput): Promise<Consultation> => {
      const { apiClient } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      return openSessionOperation(apiClient, store, getLogger(), input);
    },
    [store, getLogger],
  );

  /**
   * Load a specific consultation by ID.
   * Delegates core logic to shared sessionUtils (REFACTOR-02).
   */
  const loadConsultation = useCallback(
    async (id: string): Promise<Consultation> => {
      const { apiClient } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      return loadConsultationOperation(apiClient, store, getLogger(), id);
    },
    [store, getLogger],
  );

  const findByPatientDate = useCallback(
    async (patientId: string, date: string): Promise<Consultation[]> => {
      const { apiClient } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');

      logger?.debug('Finding consultations by patient and date', {
        operation: 'findByPatientDate',
        component: 'useArca',
        patientId,
        attributes: { date },
      });

      return apiClient.get<Consultation[]>(CONSULTATION_ENDPOINTS.PATIENT_DATE(patientId, date));
    },
    [store, getLogger],
  );

  /**
   * Get patient consultation history.
   * Delegates to shared sessionUtils (REFACTOR-02).
   */
  const getPatientHistory = useCallback(
    async (patientId: string, pagination?: PaginationParams): Promise<Consultation[]> => {
      const { apiClient } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      return getPatientHistoryOperation(apiClient, getLogger(), patientId, pagination);
    },
    [store, getLogger],
  );

  /**
   * Get consultation timeline (SES-04).
   * Supports scope='single' (default) or scope='chain' for the entire consultation chain.
   */
  const getTimeline = useCallback(
    async (scope?: TimelineScope): Promise<TimelineEntry[]> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('getTimeline', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
      });

      try {
        let url = CONSULTATION_ENDPOINTS.TIMELINE(consultation.id);
        if (scope) {
          url += `?scope=${scope}`;
        }

        const timeline = await apiClient.get<TimelineEntry[]>(url);

        timer?.end(true, { attributes: { entryCount: timeline.length, scope: scope || 'single' } });
        logger?.debug('Timeline loaded', {
          operation: 'getTimeline',
          component: 'useArca',
          sdk: { consultationId: consultation.id },
          attributes: { entryCount: timeline.length },
        });

        return timeline;
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

  const listConsultations = useCallback(
    async (params?: ListConsultationsParams): Promise<PaginatedConsultations> => {
      const { apiClient } = store;
      if (!apiClient) throw new Error('SDK not initialized');

      try {
        const query = new URLSearchParams();
        if (params) {
          for (const [key, value] of Object.entries(params)) {
            if (value !== undefined) query.set(key, String(value));
          }
        }
        const qs = query.toString();
        const url = qs ? `${CONSULTATION_ENDPOINTS.LIST}?${qs}` : CONSULTATION_ENDPOINTS.LIST;

        return await apiClient.get<PaginatedConsultations>(url);
      } catch (error) {
        store.setSessionError(error as Error);
        throw error;
      }
    },
    [store],
  );

  // ==========================================================================
  // Audio Actions
  // ==========================================================================

  const startAudio = useCallback(
    async (options?: AudioStartOptions): Promise<void> => {
      const { pluginManager, consultation } = store;
      const logger = getLogger();
      if (!pluginManager) throw new Error('SDK not initialized');

      if (options?.language) {
        store.setAudioLanguage(options.language);
      }

      const timer = logger?.startOperation('startAudio', {
        component: 'useArca',
        sdk: { consultationId: consultation?.id },
        attributes: { language: options?.language, pipelineId: options?.pipelineId },
      });

      try {
        // Get user media
        logger?.debug('Requesting microphone access', {
          operation: 'startAudio',
          component: 'useArca',
        });
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const track = stream.getAudioTracks()[0];

        // Create audio context
        const audioContext = new AudioContext();

        // Set up plugin callbacks
        pluginManager.setCallbacks({
          onTranscription: (result: TranscriptionResult) => {
            if (result.isFinal) {
              store.setCurrentTranscript('');
              // Auto-add transcription to context if consultation active
              const { consultation, apiClient } = store;
              if (consultation && apiClient) {
                logger?.debug('Adding final transcription to context', {
                  operation: 'onTranscription',
                  component: 'useArca',
                  sdk: { consultationId: consultation.id },
                  attributes: { textLength: result.text.length },
                });
                apiClient
                  .post<ContextItem>(CONTEXT_ENDPOINTS.ADD(consultation.id), {
                    type: 'TRANSCRIPT',
                    content: result.text,
                    source: 'TRANSCRIPTION',
                    structuredData: { segments: result.segments },
                  })
                  .then((item) => store.addContextItem(item))
                  .catch((error) => {
                    logger?.error('Failed to add transcription to context', {
                      operation: 'onTranscription',
                      component: 'useArca',
                      error: error as Error,
                      sdk: { consultationId: consultation.id },
                    });
                  });
              }

              // NER-L-02: Auto-trigger NER on final transcriptions via knowledge pipeline
              const knowledgePipeline = pluginManager.getKnowledgePipeline();
              if (knowledgePipeline && knowledgePipeline.state.isReady) {
                logger?.debug('Auto-triggering NER on final transcription', {
                  operation: 'onTranscription',
                  component: 'useArca',
                  attributes: { textLength: result.text.length },
                });
                knowledgePipeline
                  .process({ text: result.text })
                  .then((output) => {
                    if (output.entities?.length) {
                      store.addEntities(output.entities);
                      logger?.debug('Auto-NER entities extracted', {
                        operation: 'onTranscription',
                        component: 'useArca',
                        attributes: { entityCount: output.entities.length },
                      });
                    }
                  })
                  .catch((error) => {
                    logger?.error('Auto-NER failed on transcription', {
                      operation: 'onTranscription',
                      component: 'useArca',
                      error: error as Error,
                    });
                  });
              }
            } else {
              store.setCurrentTranscript(result.text);
            }
          },
          onVADEvent: (event) => {
            store.setIsSpeaking(event.type === 'speech-start');
          },
          onError: (error, plugin) => {
            logger?.error(`Plugin error: ${plugin}`, {
              operation: 'onPluginError',
              component: 'useArca',
              error: error,
              attributes: { plugin },
            });
            store.setAudioError(error);
          },
        });

        // Initialize plugins
        await pluginManager.initialize(track, audioContext);

        store.setIsCapturing(true);
        store.setAudioPlugins(pluginManager.getStates());
        store.setAudioError(null);

        timer?.end(true, {
          attributes: {
            sampleRate: audioContext.sampleRate,
            trackLabel: track.label,
          },
        });

        logger?.info('Audio capture started', {
          operation: 'startAudio',
          component: 'useArca',
          success: true,
          sdk: { consultationId: consultation?.id },
        });
      } catch (error) {
        timer?.error(error as Error);
        store.setAudioError(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

  const stopAudio = useCallback(async (): Promise<void> => {
    const { pluginManager, consultation } = store;
    const logger = getLogger();
    if (!pluginManager) return;

    logger?.debug('Stopping audio capture', {
      operation: 'stopAudio',
      component: 'useArca',
      sdk: { consultationId: consultation?.id },
    });

    await pluginManager.destroy();
    store.setIsCapturing(false);
    store.setIsSpeaking(false);
    store.setAudioLevel(0);
    store.setCurrentTranscript('');

    logger?.info('Audio capture stopped', {
      operation: 'stopAudio',
      component: 'useArca',
      success: true,
    });
  }, [store, getLogger]);

  const muteAudio = useCallback(() => {
    const logger = getLogger();
    logger?.debug('Muting audio', { operation: 'muteAudio', component: 'useArca' });
    store.setIsMuted(true);
  }, [store, getLogger]);

  const unmuteAudio = useCallback(() => {
    const logger = getLogger();
    logger?.debug('Unmuting audio', { operation: 'unmuteAudio', component: 'useArca' });
    store.setIsMuted(false);
  }, [store, getLogger]);

  const toggleNoiseFilter = useCallback(
    async (enabled?: boolean) => {
      const { pluginManager } = store;
      const logger = getLogger();
      if (!pluginManager) return;

      const newState = enabled ?? !pluginManager.getStates().noiseFilter.isActive;

      logger?.debug('Toggling noise filter', {
        operation: 'toggleNoiseFilter',
        component: 'useArca',
        attributes: { newState },
      });

      await pluginManager.setEnabled('noiseFilter', newState);
      store.setAudioPlugins(pluginManager.getStates());
    },
    [store, getLogger],
  );

  /**
   * Toggle STT on/off.
   * ASR-L-01/HOOK-05: Exposes STT toggle through the unified hook.
   */
  const toggleSTT = useCallback(
    async (enabled?: boolean) => {
      const { pluginManager } = store;
      const logger = getLogger();
      if (!pluginManager) return;

      const currentStates = pluginManager.getStates();
      const newState = enabled ?? !currentStates.stt.isActive;

      logger?.debug('Toggling STT', {
        operation: 'toggleSTT',
        component: 'useArca',
        attributes: { newState },
      });

      await pluginManager.setEnabled('stt', newState);
      store.setAudioPlugins(pluginManager.getStates());
    },
    [store, getLogger],
  );

  /**
   * Toggle VAD on/off.
   * ASR-L-01/HOOK-05: Exposes VAD toggle through the unified hook.
   */
  const toggleVAD = useCallback(
    async (enabled?: boolean) => {
      const { pluginManager } = store;
      const logger = getLogger();
      if (!pluginManager) return;

      const currentStates = pluginManager.getStates();
      const newState = enabled ?? !currentStates.vad.isActive;

      logger?.debug('Toggling VAD', {
        operation: 'toggleVAD',
        component: 'useArca',
        attributes: { newState },
      });

      await pluginManager.setEnabled('vad', newState);
      store.setAudioPlugins(pluginManager.getStates());
    },
    [store, getLogger],
  );

  // ==========================================================================
  // Context Actions
  // ==========================================================================

  const addCaseNote = useCallback(
    async (content: string, metadata?: Record<string, unknown>): Promise<ContextItem> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('addCaseNote', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
      });

      store.setContextLoading(true);
      store.setContextError(null);

      try {
        const item = await apiClient.post<ContextItem>(CONTEXT_ENDPOINTS.ADD(consultation.id), {
          type: 'CASE_NOTE',
          content,
          source: 'USER',
          structuredData: metadata,
        });
        store.addContextItem(item);

        timer?.end(true, {
          attributes: { contextItemId: item.id, contentLength: content.length },
        });

        return item;
      } catch (error) {
        timer?.error(error as Error);
        store.setContextError(error as Error);
        throw error;
      } finally {
        store.setContextLoading(false);
      }
    },
    [store, getLogger],
  );

  const addTranscription = useCallback(
    async (text: string, metadata?: Record<string, unknown>): Promise<ContextItem> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('addTranscription', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
      });

      store.setContextLoading(true);
      store.setContextError(null);

      try {
        const item = await apiClient.post<ContextItem>(CONTEXT_ENDPOINTS.ADD(consultation.id), {
          type: 'TRANSCRIPT',
          content: text,
          source: 'TRANSCRIPTION',
          structuredData: metadata,
        });
        store.addContextItem(item);

        timer?.end(true, {
          attributes: { contextItemId: item.id, textLength: text.length },
        });

        return item;
      } catch (error) {
        timer?.error(error as Error);
        store.setContextError(error as Error);
        throw error;
      } finally {
        store.setContextLoading(false);
      }
    },
    [store, getLogger],
  );

  const updateContextItem = useCallback(
    async (id: string, content: string): Promise<void> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('updateContextItem', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId: id },
      });

      store.setContextLoading(true);
      store.setContextError(null);

      try {
        await apiClient.patch(CONTEXT_ENDPOINTS.UPDATE(consultation.id, id), {
          content,
        });
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
    [store, getLogger],
  );

  const loadSharedContext = useCallback(async (): Promise<ContextItem[]> => {
    const { apiClient, consultation } = store;
    const logger = getLogger();
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    const timer = logger?.startOperation('loadSharedContext', {
      component: 'useArca',
      sdk: { consultationId: consultation.id },
    });

    store.setContextLoading(true);
    store.setContextError(null);

    try {
      const items = await apiClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.SHARED(consultation.id));
      store.setSharedContext(items);

      timer?.end(true, { attributes: { itemCount: items.length } });
      logger?.debug('Shared context loaded', {
        operation: 'loadSharedContext',
        component: 'useArca',
        sdk: { consultationId: consultation.id },
        attributes: { itemCount: items.length },
      });

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
        component: 'useArca',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId: contextItemId || 'all' },
      });

      store.setContextLoading(true);
      store.setContextError(null);

      try {
        const endpoint = contextItemId ? ENTITY_ENDPOINTS.GET_FOR_ITEM(consultation.id, contextItemId) : ENTITY_ENDPOINTS.GET_ALL(consultation.id);

        const data = await apiClient.get<{ entities: MedicalEntity[] }>(endpoint);
        store.setEntities(data.entities);

        timer?.end(true, { attributes: { entityCount: data.entities.length } });
        logger?.info('Entities extracted', {
          operation: 'extractEntities',
          component: 'useArca',
          success: true,
          sdk: { consultationId: consultation.id },
          attributes: {
            entityCount: data.entities.length,
            contextItemId: contextItemId || 'all',
          },
        });

        return data.entities;
      } catch (error) {
        timer?.error(error as Error);
        store.setContextError(error as Error);
        throw error;
      } finally {
        store.setContextLoading(false);
      }
    },
    [store, getLogger],
  );

  /**
   * Get version history for a context item (SES-05).
   */
  const getContextVersions = useCallback(
    async (contextItemId: string): Promise<ContextVersionEntry[]> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('getContextVersions', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId },
      });

      try {
        const versions = await apiClient.get<ContextVersionEntry[]>(CONTEXT_ENDPOINTS.VERSIONS(consultation.id, contextItemId));

        timer?.end(true, { attributes: { versionCount: versions.length } });
        logger?.debug('Context versions loaded', {
          operation: 'getContextVersions',
          component: 'useArca',
          sdk: { consultationId: consultation.id },
          attributes: { contextItemId, versionCount: versions.length },
        });

        return versions;
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

  /**
   * Trigger backend NER entity extraction on a specific context item (NER-R-03).
   * Uses SUMMARY_ENDPOINTS.EXTRACT_ENTITIES which was defined but never wired.
   */
  const triggerEntityExtraction = useCallback(
    async (contextItemId: string): Promise<void> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('triggerEntityExtraction', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId },
      });

      try {
        await apiClient.post(SUMMARY_ENDPOINTS.EXTRACT_ENTITIES(consultation.id, contextItemId), {});

        timer?.end(true);
        logger?.info('Entity extraction triggered', {
          operation: 'triggerEntityExtraction',
          component: 'useArca',
          success: true,
          sdk: { consultationId: consultation.id },
          attributes: { contextItemId },
        });
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

  const getItems = useCallback(
    async (filters?: ContextFilters): Promise<ContextItem[]> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('getItems', {
        component: 'useArca',
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
    [store, getLogger],
  );

  /**
   * Fetch transcriptions from backend.
   * SES-07: Uses dedicated /consultations/:id/context/transcriptions endpoint.
   */
  const fetchTranscriptions = useCallback(async (): Promise<ContextItem[]> => {
    const { apiClient, consultation } = store;
    const logger = getLogger();
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    logger?.debug('Fetching transcriptions from backend', {
      operation: 'fetchTranscriptions',
      component: 'useArca',
      sdk: { consultationId: consultation.id },
    });

    const items = await apiClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.TRANSCRIPTIONS(consultation.id));

    return items;
  }, [store, getLogger]);

  /**
   * Fetch case notes from backend.
   * SES-07: Uses dedicated /consultations/:id/context/case-notes endpoint.
   */
  const fetchCaseNotes = useCallback(async (): Promise<ContextItem[]> => {
    const { apiClient, consultation } = store;
    const logger = getLogger();
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    logger?.debug('Fetching case notes from backend', {
      operation: 'fetchCaseNotes',
      component: 'useArca',
      sdk: { consultationId: consultation.id },
    });

    const items = await apiClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.CASE_NOTES(consultation.id));

    return items;
  }, [store, getLogger]);

  // ==========================================================================
  // Summary Actions
  // ==========================================================================

  const generatePreSummary = useCallback(
    async (options?: SummaryGenerationOptions): Promise<SummaryResponse> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('generatePreSummary', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
      });

      store.setSummaryGenerating(true);
      store.setSummaryError(null);

      try {
        const summary = await apiClient.post<SummaryResponse>(SUMMARY_ENDPOINTS.PRE_SUMMARY(consultation.id), options);
        store.addSummary(summary);

        timer?.end(true, {
          attributes: {
            summaryId: summary.id,
            contentLength: summary.content?.length || 0,
            hasDnaStyle: !!options?.dnaStyleId,
          },
        });

        logger?.info('Pre-summary generated', {
          operation: 'generatePreSummary',
          component: 'useArca',
          success: true,
          sdk: { consultationId: consultation.id },
        });

        return summary;
      } catch (error) {
        timer?.error(error as Error);
        store.setSummaryError(error as Error);
        throw error;
      } finally {
        store.setSummaryGenerating(false);
      }
    },
    [store, getLogger],
  );

  const generateSummary = useCallback(
    async (options?: SummaryGenerationOptions): Promise<SummaryResponse> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('generateSummary', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
      });

      store.setSummaryGenerating(true);
      store.setSummaryError(null);

      try {
        const summary = await apiClient.post<SummaryResponse>(SUMMARY_ENDPOINTS.GENERATE(consultation.id), options);
        store.addSummary(summary);

        timer?.end(true, {
          attributes: {
            summaryId: summary.id,
            contentLength: summary.content?.length || 0,
            hasDnaStyle: !!options?.dnaStyleId,
            includeNER: !!options?.includeNER,
          },
        });

        logger?.info('Summary generated', {
          operation: 'generateSummary',
          component: 'useArca',
          success: true,
          sdk: { consultationId: consultation.id },
        });

        return summary;
      } catch (error) {
        timer?.error(error as Error);
        store.setSummaryError(error as Error);
        throw error;
      } finally {
        store.setSummaryGenerating(false);
      }
    },
    [store, getLogger],
  );

  const updateSummary = useCallback(
    async (id: string, content: string, options?: UpdateSummaryOptions): Promise<void> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('updateSummary', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
        attributes: { summaryId: id },
      });

      store.setSummaryGenerating(true);
      store.setSummaryError(null);

      try {
        await apiClient.patch(SUMMARY_ENDPOINTS.UPDATE(consultation.id, id), {
          content,
          ...options,
        });
        timer?.end(true, { attributes: { contentLength: content.length } });
      } catch (error) {
        timer?.error(error as Error);
        store.setSummaryError(error as Error);
        throw error;
      } finally {
        store.setSummaryGenerating(false);
      }
    },
    [store, getLogger],
  );

  /**
   * SUM-06: DNA analysis has no backend support.
   * This method is kept for interface compatibility but throws immediately.
   * @deprecated No backend endpoint exists for DNA analysis.
   */
  const analyzeDNA = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Stub; no backend; param kept for interface compatibility.
    async (_texts: string[]): Promise<DNAStyle> => {
      const logger = getLogger();

      logger?.warn('analyzeDNA called but no backend endpoint exists', {
        operation: 'analyzeDNA',
        component: 'useArca',
      });

      throw new Error('DNA analysis is not supported: no backend endpoint exists. ' + 'This feature is planned for a future release.');
    },
    [getLogger],
  );

  /**
   * Load all summaries for the current consultation from backend (SUM-04).
   * HOOK-06: Fetches existing summaries so state is not lost after page refresh.
   * SES-06: Accepts optional pagination params.
   */
  const loadSummaries = useCallback(
    async (pagination?: PaginationParams): Promise<SummaryResponse[]> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('loadSummaries', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
      });

      try {
        let url = SUMMARY_ENDPOINTS.LIST(consultation.id);
        if (pagination) {
          const params = new URLSearchParams();
          if (pagination.page != null) params.set('page', String(pagination.page));
          if (pagination.limit != null) params.set('limit', String(pagination.limit));
          const qs = params.toString();
          if (qs) url += `?${qs}`;
        }

        const summaries = await apiClient.get<SummaryResponse[]>(url);
        store.setSummaries(summaries);

        timer?.end(true, { attributes: { summaryCount: summaries.length } });
        logger?.info('Summaries loaded from backend', {
          operation: 'loadSummaries',
          component: 'useArca',
          success: true,
          sdk: { consultationId: consultation.id },
          attributes: { summaryCount: summaries.length },
        });

        return summaries;
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

  /**
   * Generate summary asynchronously (SUM-01).
   * Returns a job response (HTTP 202) that can be polled for status.
   */
  const generateSummaryAsync = useCallback(
    async (options?: SummaryGenerationOptions): Promise<AsyncJobResponse> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('generateSummaryAsync', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
      });

      store.setSummaryGenerating(true);
      store.setSummaryError(null);

      try {
        const job = await apiClient.post<AsyncJobResponse>(SUMMARY_ENDPOINTS.GENERATE_ASYNC(consultation.id), options || {});

        timer?.end(true, { attributes: { jobId: job.jobId } });
        logger?.info('Async summary job created', {
          operation: 'generateSummaryAsync',
          component: 'useArca',
          success: true,
          sdk: { consultationId: consultation.id },
          attributes: { jobId: job.jobId },
        });

        return job;
      } catch (error) {
        timer?.error(error as Error);
        store.setSummaryError(error as Error);
        throw error;
      } finally {
        store.setSummaryGenerating(false);
      }
    },
    [store, getLogger],
  );

  /**
   * Generate pre-summary asynchronously (SUM-01).
   */
  const generatePreSummaryAsync = useCallback(
    async (options?: SummaryGenerationOptions): Promise<AsyncJobResponse> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('generatePreSummaryAsync', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
      });

      store.setSummaryGenerating(true);
      store.setSummaryError(null);

      try {
        const job = await apiClient.post<AsyncJobResponse>(SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC(consultation.id), options || {});

        timer?.end(true, { attributes: { jobId: job.jobId } });
        return job;
      } catch (error) {
        timer?.error(error as Error);
        store.setSummaryError(error as Error);
        throw error;
      } finally {
        store.setSummaryGenerating(false);
      }
    },
    [store, getLogger],
  );

  /**
   * Generate comprehensive (cross-chain) summary (SUM-02).
   */
  const generateComprehensiveSummary = useCallback(
    async (options?: { dnaStyleId?: string; includeNER?: boolean }): Promise<ComprehensiveSummaryResponse> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('generateComprehensiveSummary', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
      });

      store.setSummaryGenerating(true);
      store.setSummaryError(null);

      try {
        const result = await apiClient.post<ComprehensiveSummaryResponse>(SUMMARY_ENDPOINTS.COMPREHENSIVE(consultation.id), options || {});

        timer?.end(true, { attributes: { resultId: result.id } });
        logger?.info('Comprehensive summary generated', {
          operation: 'generateComprehensiveSummary',
          component: 'useArca',
          success: true,
          sdk: { consultationId: consultation.id },
        });

        return result;
      } catch (error) {
        timer?.error(error as Error);
        store.setSummaryError(error as Error);
        throw error;
      } finally {
        store.setSummaryGenerating(false);
      }
    },
    [store, getLogger],
  );

  /**
   * Get the latest pre-summary for the current consultation (SUM-03).
   */
  const getLatestPreSummary = useCallback(async (): Promise<SummaryResponse> => {
    const { apiClient, consultation } = store;
    const logger = getLogger();
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    const timer = logger?.startOperation('getLatestPreSummary', {
      component: 'useArca',
      sdk: { consultationId: consultation.id },
    });

    try {
      const preSummary = await apiClient.get<SummaryResponse>(SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY(consultation.id));

      timer?.end(true, { attributes: { summaryId: preSummary.id } });
      return preSummary;
    } catch (error) {
      timer?.error(error as Error);
      throw error;
    }
  }, [store, getLogger]);

  /**
   * Get version history for a summary context item (WS-5).
   */
  const getSummaryHistory = useCallback(
    async (summaryId: string): Promise<SummaryVersionEntry[]> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = getLogger()?.startOperation('getSummaryHistory', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
      });

      try {
        const versions = await apiClient.get<SummaryVersionEntry[]>(SUMMARY_ENDPOINTS.VERSIONS(consultation.id, summaryId));
        timer?.end(true, { attributes: { versionCount: versions.length } });
        return versions;
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

  /**
   * Compare two summary versions using word-level diff (WS-5).
   */
  const compareSummaryVersions = useCallback(
    async (contextItemId: string, v1: number, v2: number): Promise<DiffResult> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = getLogger()?.startOperation('compareSummaryVersions', {
        component: 'useArca',
        sdk: { consultationId: consultation.id },
      });

      try {
        const [version1, version2] = await Promise.all([
          apiClient.get<{ content: string }>(CONTEXT_ENDPOINTS.VERSION(consultation.id, contextItemId, v1)),
          apiClient.get<{ content: string }>(CONTEXT_ENDPOINTS.VERSION(consultation.id, contextItemId, v2)),
        ]);
        const result = computeSummaryDiff(version1.content, version2.content);
        timer?.end(true);
        return result;
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

  // ==========================================================================
  // Retry Wrapper (HOOK-07)
  // ==========================================================================

  /**
   * Retry wrapper for API operations.
   * HOOK-07: Delegates to shared withRetry utility from errorUtils.
   * Adds logging via onRetry callback.
   */
  const withRetry = useCallback(
    async <T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> => {
      const logger = getLogger();

      return withRetryUtil<T>(fn, {
        ...options,
        onRetry: (attempt, error) => {
          logger?.debug(`Retrying after retriable error (attempt ${attempt}/${options?.maxRetries ?? 3})`, {
            operation: 'withRetry',
            component: 'useArca',
            attributes: {
              attempt,
              maxRetries: options?.maxRetries ?? 3,
              delayMs: options?.delayMs ?? 1000,
            },
            error: error as Error,
          });
          options?.onRetry?.(attempt, error);
        },
      });
    },
    [getLogger],
  );

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
        component: 'useArca',
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
        component: 'useArca',
      });
    }
  }, [store, getLogger]);

  const triggerNER = useCallback(
    async (text?: string): Promise<MedicalEntity[]> => {
      const { pluginManager } = store;
      const logger = getLogger();

      const timer = logger?.startOperation('triggerNER', {
        component: 'useArca',
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
          component: 'useArca',
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
      component: 'useArca',
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
        component: 'useArca',
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

  const transcriptions = useMemo(() => selectTranscriptions(store), [store.contextItems]);
  const caseNotes = useMemo(() => selectCaseNotes(store), [store.contextItems]);
  const isAudioSource = selectIsAudioSource(store);
  const transcriptionPipelineState = selectTranscriptionPipelineState(store);
  const knowledgePipelineState = selectKnowledgePipelineState(store);

  const session = useMemo<UseArcaSession>(
    () => ({
      consultation: store.consultation,
      relatedConsultations: store.relatedConsultations,
      isLoading: store.sessionLoading,
      error: store.sessionError,
      open: openSession,
      load: loadConsultation,
      findByPatientDate,
      getPatientHistory,
      getTimeline,
      listConsultations,
    }),
    [
      store.consultation,
      store.relatedConsultations,
      store.sessionLoading,
      store.sessionError,
      openSession,
      loadConsultation,
      findByPatientDate,
      getPatientHistory,
      getTimeline,
      listConsultations,
    ],
  );

  const audio = useMemo<UseArcaAudio>(
    () => ({
      isCapturing: store.isCapturing,
      isMuted: store.isMuted,
      level: store.audioLevel,
      isSpeaking: store.isSpeaking,
      currentTranscript: store.currentTranscript,
      transcriptSegments: store.transcriptSegments ?? [],
      language: store.audioLanguage ?? 'en',
      plugins: store.audioPlugins,
      error: store.audioError,
      start: startAudio,
      stop: stopAudio,
      mute: muteAudio,
      unmute: unmuteAudio,
      toggleNoiseFilter,
      toggleSTT,
      toggleVAD,
    }),
    [
      store.isCapturing,
      store.isMuted,
      store.audioLevel,
      store.isSpeaking,
      store.currentTranscript,
      store.transcriptSegments,
      store.audioLanguage,
      store.audioPlugins,
      store.audioError,
      startAudio,
      stopAudio,
      muteAudio,
      unmuteAudio,
      toggleNoiseFilter,
      toggleSTT,
      toggleVAD,
    ],
  );

  const context = useMemo<UseArcaContext>(
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
      updateItem: updateContextItem,
      getItems,
      loadSharedContext,
      extractEntities,
      getContextVersions,
      triggerEntityExtraction,
      fetchTranscriptions,
      fetchCaseNotes,
    }),
    [
      store.contextItems,
      transcriptions,
      caseNotes,
      store.entities,
      store.sharedContext,
      store.contextLoading,
      store.contextError,
      addCaseNote,
      addTranscription,
      updateContextItem,
      getItems,
      loadSharedContext,
      extractEntities,
      getContextVersions,
      triggerEntityExtraction,
      fetchTranscriptions,
      fetchCaseNotes,
    ],
  );

  const latestSummary = store.summaries.find((s) => s.type === 'summary') ?? null;
  const latestPreSummary = store.summaries.find((s) => s.type === 'pre_summary') ?? null;

  const summaryInterface = useMemo<UseArcaSummary>(
    () => ({
      preSummary: latestPreSummary,
      summary: latestSummary,
      all: store.summaries,
      dnaStyle: store.dnaStyle,
      isGenerating: store.summaryGenerating,
      error: store.summaryError,
      generatePreSummary,
      generateSummary,
      updateSummary,
      analyzeDNA,
      loadSummaries,
      generateSummaryAsync,
      generatePreSummaryAsync,
      generateComprehensiveSummary,
      getLatestPreSummary,
      getSummaryHistory,
      compareSummaryVersions,
    }),
    [
      latestPreSummary,
      latestSummary,
      store.summaries,
      store.dnaStyle,
      store.summaryGenerating,
      store.summaryError,
      generatePreSummary,
      generateSummary,
      updateSummary,
      analyzeDNA,
      loadSummaries,
      generateSummaryAsync,
      generatePreSummaryAsync,
      generateComprehensiveSummary,
      getLatestPreSummary,
      getSummaryHistory,
      compareSummaryVersions,
    ],
  );

  const pipelines = useMemo<UseArcaPipelineControl>(
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

  // ==========================================================================
  // Lifecycle (C-001)
  // ==========================================================================

  const requestGracefulShutdown = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reserved for future timeout behavior.
    async (_opts?: { timeoutMs?: number }): Promise<void> => {
      const { pluginManager } = store;
      const logger = getLogger();

      logger?.info('Graceful shutdown requested', {
        operation: 'requestGracefulShutdown',
        component: 'useArca',
      });

      if (pluginManager) {
        await pluginManager.destroy();
      }
      store.setIsCapturing(false);
      store.setIsSpeaking(false);
      store.setAudioLevel(0);
      store.setCurrentTranscript('');
    },
    [store, getLogger],
  );

  const forceShutdown = useCallback(async (): Promise<void> => {
    const { pluginManager } = store;
    const logger = getLogger();

    logger?.warn('Force shutdown requested', {
      operation: 'forceShutdown',
      component: 'useArca',
    });

    if (pluginManager) {
      await pluginManager.destroy();
    }
    store.setIsCapturing(false);
    store.setIsSpeaking(false);
    store.setAudioLevel(0);
    store.setCurrentTranscript('');
  }, [store, getLogger]);

  const lifecycle = useMemo<UseArcaLifecycle>(() => {
    const pendingOps: string[] = [];
    if (store.isCapturing) pendingOps.push('audio_capture');
    if (store.summaryGenerating) pendingOps.push('summary_generation');

    let status: UseArcaLifecycle['status'] = 'IDLE';
    if (store.globalError) {
      status = 'ERROR';
    } else if (store.initialized) {
      status = 'RUNNING';
    }

    return {
      status,
      canClose: !store.isCapturing && !store.summaryGenerating,
      pendingOperations: pendingOps,
      state: {
        audioCapture: store.isCapturing ? 'active' : 'inactive',
        transcriptionPipeline: transcriptionPipelineState?.status ?? 'inactive',
        knowledgePipeline: knowledgePipelineState?.status ?? 'inactive',
        hasUnsavedData: store.isCapturing || store.summaryGenerating,
      },
      requestGracefulShutdown,
      forceShutdown,
    };
  }, [
    store.initialized,
    store.globalError,
    store.isCapturing,
    store.summaryGenerating,
    transcriptionPipelineState,
    knowledgePipelineState,
    requestGracefulShutdown,
    forceShutdown,
  ]);

  return {
    session,
    audio,
    context,
    summary: summaryInterface,
    isAudioSource,
    pipelines,
    lifecycle,
    isReady: store.initialized,
    error: store.globalError,
    withRetry,
  };
}
