/**
 * Agentic Store Unit Tests
 *
 * Tests for the Zustand store implementation.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  // These unit tests exercise the store-creator logic
  // (clearOnLogout/clearTenantSessionData/slices) in isolation, so they bind to
  // the module singleton directly. Production code uses the context-backed
  // `useAgenticStore` instead; the singleton no longer carries the `useAgenticStore` name.
  agenticStoreSingleton as useAgenticStore,
  selectTranscriptions,
  selectCaseNotes,
  selectSummaryItems,
  selectLatestSummary,
  selectLatestPreSummary,
  selectIsAudioSource,
  selectTranscriptionPipelineState,
  selectKnowledgePipelineState,
  selectConsultation,
  selectIsCapturing,
  selectAudioLevel,
  selectEntities,
  selectSummaries,
  selectConfigManager,
  selectResolvedConfig,
  selectConfigReady,
  selectAudioDropped,
  selectAudioDegraded,
} from '../agenticStore';
import type { ContextItem, SummaryResponse, PipelineStateInfo } from '../../types';

// Mock the shared `arcaai-config` IDB helpers so the
// rewritten `clearOnLogout` contract can assert the outgoing personalization
// row is deleted by namespace (and that no wholesale `.clear()` runs) without a
// real IndexedDB. Only `clearOnLogout` touches configDB; other store actions do
// not, so this mock is inert for the rest of the suite.
vi.mock('../../core/configDB', () => ({
  ARCAAI_CONFIG_DB_NAME: 'arcaai-config',
  ARCAAI_CONFIG_DB_VERSION: 3,
  USER_PREFERENCES_STORE: 'user-preferences',
  PERSONALIZATION_STORE: 'personalization',
  LEGACY_PERSONALIZATION_GLOBAL_KEY: 'arcaai-personalization',
  openConfigDB: vi.fn(),
  applyConfigDBUpgrade: vi.fn(),
  configDBGet: vi.fn(async () => undefined),
  configDBSet: vi.fn(async () => {}),
  configDBDelete: vi.fn(async () => {}),
  configDBClear: vi.fn(async () => {}),
}));

import { configDBDelete, configDBClear } from '../../core/configDB';

// Reset store before each test
const initialStoreState = useAgenticStore.getState();

describe('agenticStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useAgenticStore.setState(initialStoreState, true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should start with default state', () => {
      const state = useAgenticStore.getState();

      expect(state.initialized).toBe(false);
      expect(state.config).toBeNull();
      expect(state.consultation).toBeNull();
      expect(state.contextItems).toEqual([]);
      expect(state.isCapturing).toBe(false);
      expect(state.summaries).toEqual([]);
    });

    it('should initialize with managers', () => {
      const mockConfig = { api: { baseUrl: 'http://test', apiKey: 'key' } };
      const mockApiClient = {} as any;
      const mockPluginManager = {} as any;
      const mockPersonalizationManager = { getPreferences: () => ({}) } as any;
      const mockModelRegistry = {} as any;
      const mockLogger = {} as any;

      useAgenticStore
        .getState()
        .initialize(mockConfig as any, mockApiClient, mockPluginManager, mockPersonalizationManager, mockModelRegistry, mockLogger);

      const state = useAgenticStore.getState();
      expect(state.initialized).toBe(true);
      expect(state.config).toBe(mockConfig);
      expect(state.apiClient).toBe(mockApiClient);
    });
  });

  describe('consultation actions', () => {
    it('should set consultation', () => {
      const consultation = {
        id: 'test-123',
        patientId: 'patient-1',
        status: 'active',
      };

      useAgenticStore.getState().setConsultation(consultation as any);

      expect(useAgenticStore.getState().consultation).toEqual(consultation);
    });

    it('should clear consultation', () => {
      useAgenticStore.getState().setConsultation({ id: 'test' } as any);
      useAgenticStore.getState().setConsultation(null);

      expect(useAgenticStore.getState().consultation).toBeNull();
    });

    it('should set related consultations', () => {
      const consultations = [{ id: '1' }, { id: '2' }];

      useAgenticStore.getState().setRelatedConsultations(consultations as any);

      expect(useAgenticStore.getState().relatedConsultations).toEqual(consultations);
    });

    it('should set session loading state', () => {
      useAgenticStore.getState().setSessionLoading(true);

      expect(useAgenticStore.getState().sessionLoading).toBe(true);
    });

    it('should set session error', () => {
      const error = new Error('Test error');

      useAgenticStore.getState().setSessionError(error);

      expect(useAgenticStore.getState().sessionError).toBe(error);
    });
  });

  describe('context actions', () => {
    const mockContextItem = {
      id: 'item-1',
      consultationId: 'consultation-1',
      type: 'transcription',
      content: 'Test content',
      createdAt: new Date().toISOString(),
    } as unknown as ContextItem;

    it('should set context items', () => {
      const items = [mockContextItem];

      useAgenticStore.getState().setContextItems(items);

      expect(useAgenticStore.getState().contextItems).toEqual(items);
    });

    it('should add context item', () => {
      useAgenticStore.getState().addContextItem(mockContextItem);

      expect(useAgenticStore.getState().contextItems).toContainEqual(mockContextItem);
    });

    it('should update context item', () => {
      useAgenticStore.getState().setContextItems([mockContextItem]);
      useAgenticStore.getState().updateContextItem('item-1', { content: 'Updated' });

      const item = useAgenticStore.getState().contextItems.find((i) => i.id === 'item-1');
      expect(item?.content).toBe('Updated');
    });

    it('should remove context item', () => {
      useAgenticStore.getState().setContextItems([mockContextItem]);
      useAgenticStore.getState().removeContextItem('item-1');

      expect(useAgenticStore.getState().contextItems).toHaveLength(0);
    });

    it('should set shared context', () => {
      const sharedItems = [{ ...mockContextItem, id: 'shared-1' }];

      useAgenticStore.getState().setSharedContext(sharedItems);

      expect(useAgenticStore.getState().sharedContext).toEqual(sharedItems);
    });

    it('should set entities', () => {
      const entities = [{ id: 'entity-1', type: 'medication', value: 'Aspirin' }];

      useAgenticStore.getState().setEntities(entities as any);

      expect(useAgenticStore.getState().entities).toEqual(entities);
    });

    it('should add entities', () => {
      const entity1 = { id: 'entity-1', type: 'medication', value: 'Aspirin' };
      const entity2 = { id: 'entity-2', type: 'condition', value: 'Headache' };

      useAgenticStore.getState().setEntities([entity1] as any);
      useAgenticStore.getState().addEntities([entity2] as any);

      expect(useAgenticStore.getState().entities).toHaveLength(2);
    });

    it('should clear context', () => {
      useAgenticStore.getState().setContextItems([mockContextItem]);
      useAgenticStore.getState().setSharedContext([mockContextItem]);
      useAgenticStore.getState().setEntities([{ id: 'e1' }] as any);
      useAgenticStore.getState().clearContext();

      const state = useAgenticStore.getState();
      expect(state.contextItems).toEqual([]);
      expect(state.sharedContext).toEqual([]);
      expect(state.entities).toEqual([]);
    });
  });

  describe('audio actions', () => {
    it('should set capturing state', () => {
      useAgenticStore.getState().setIsCapturing(true);

      expect(useAgenticStore.getState().isCapturing).toBe(true);
    });

    it('should set muted state', () => {
      useAgenticStore.getState().setIsMuted(true);

      expect(useAgenticStore.getState().isMuted).toBe(true);
    });

    it('should set audio level', () => {
      useAgenticStore.getState().setAudioLevel(0.75);

      expect(useAgenticStore.getState().audioLevel).toBe(0.75);
    });

    it('should set speaking state', () => {
      useAgenticStore.getState().setIsSpeaking(true);

      expect(useAgenticStore.getState().isSpeaking).toBe(true);
    });

    it('should set current transcript', () => {
      useAgenticStore.getState().setCurrentTranscript('Hello world');

      expect(useAgenticStore.getState().currentTranscript).toBe('Hello world');
    });

    it('should set audio plugins', () => {
      const plugins = { noiseFilter: true, vad: true, stt: false };

      useAgenticStore.getState().setAudioPlugins(plugins as unknown as Parameters<ReturnType<typeof useAgenticStore.getState>['setAudioPlugins']>[0]);

      expect(useAgenticStore.getState().audioPlugins).toEqual(plugins);
    });
  });

  describe('summary actions', () => {
    const mockSummary = {
      id: 'summary-1',
      consultationId: 'consultation-1',
      type: 'summary',
      content: 'Test summary',
      createdAt: new Date().toISOString(),
    } as unknown as SummaryResponse;

    it('should set summaries', () => {
      useAgenticStore.getState().setSummaries([mockSummary]);

      expect(useAgenticStore.getState().summaries).toEqual([mockSummary]);
    });

    it('should add summary', () => {
      useAgenticStore.getState().addSummary(mockSummary);

      expect(useAgenticStore.getState().summaries).toContainEqual(mockSummary);
    });

    it('should set DNA style', () => {
      const dnaStyle = { id: 'dna-1', name: 'Professional' };

      useAgenticStore.getState().setDNAStyle(dnaStyle as any);

      expect(useAgenticStore.getState().dnaStyle).toEqual(dnaStyle);
    });

    it('should set summary generating state', () => {
      useAgenticStore.getState().setSummaryGenerating(true);

      expect(useAgenticStore.getState().summaryGenerating).toBe(true);
    });
  });

  describe('preferences actions', () => {
    it('should set preferences', () => {
      const preferences = { theme: 'dark', language: 'en' } as Record<string, unknown>;

      useAgenticStore.getState().setPreferences(preferences);

      expect(useAgenticStore.getState().preferences).toEqual(preferences);
    });

    it('should update preferences partially', () => {
      useAgenticStore.getState().setPreferences({ theme: 'light' } as Record<string, unknown>);
      useAgenticStore.getState().updatePreferences({ language: 'es' });

      expect(useAgenticStore.getState().preferences).toEqual({
        theme: 'light',
        language: 'es',
      });
    });
  });

  describe('reset', () => {
    it('should reset state but keep managers', () => {
      const mockConfig = { api: { baseUrl: 'http://test', apiKey: 'key' } };
      const mockApiClient = {} as any;
      const mockPluginManager = {} as any;
      const mockPersonalizationManager = { getPreferences: () => ({}) } as any;
      const mockModelRegistry = {} as any;
      const mockLogger = {} as any;

      useAgenticStore
        .getState()
        .initialize(mockConfig as any, mockApiClient, mockPluginManager, mockPersonalizationManager, mockModelRegistry, mockLogger);
      useAgenticStore.getState().setConsultation({ id: 'test' } as any);
      useAgenticStore.getState().setIsCapturing(true);
      useAgenticStore.getState().reset();

      const state = useAgenticStore.getState();
      expect(state.initialized).toBe(true); // Kept
      expect(state.apiClient).toBe(mockApiClient); // Kept
      expect(state.consultation).toBeNull(); // Reset
      expect(state.isCapturing).toBe(false); // Reset
    });
  });

  describe('selectors', () => {
    const transcription = {
      id: '1',
      consultationId: 'c1',
      type: 'transcription',
      content: 'Transcription',
      createdAt: new Date().toISOString(),
    } as unknown as ContextItem;

    const caseNote = {
      id: '2',
      consultationId: 'c1',
      type: 'case_note',
      content: 'Case note',
      createdAt: new Date().toISOString(),
    } as unknown as ContextItem;

    const summaryItem = {
      id: '3',
      consultationId: 'c1',
      type: 'summary',
      content: 'Summary',
      createdAt: new Date().toISOString(),
    } as unknown as ContextItem;

    beforeEach(() => {
      useAgenticStore.getState().setContextItems([transcription, caseNote, summaryItem]);
    });

    it('selectTranscriptions should filter transcriptions', () => {
      const state = useAgenticStore.getState();
      const result = selectTranscriptions(state);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('transcription');
    });

    it('selectCaseNotes should filter case notes', () => {
      const state = useAgenticStore.getState();
      const result = selectCaseNotes(state);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('case_note');
    });

    it('selectSummaryItems should filter summaries', () => {
      const state = useAgenticStore.getState();
      const result = selectSummaryItems(state);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('summary');
    });

    it('selectLatestSummary should return latest summary', () => {
      const summary1 = {
        id: 's1',
        consultationId: 'c1',
        type: 'summary',
        content: 'First',
        createdAt: new Date().toISOString(),
      } as unknown as SummaryResponse;
      const summary2 = {
        id: 's2',
        consultationId: 'c1',
        type: 'summary',
        content: 'Second',
        createdAt: new Date().toISOString(),
      } as unknown as SummaryResponse;

      useAgenticStore.getState().setSummaries([summary1, summary2]);

      const state = useAgenticStore.getState();
      const result = selectLatestSummary(state);

      expect(result?.id).toBe('s2');
    });

    it('selectLatestPreSummary should return latest pre-summary', () => {
      const preSummary = {
        id: 'ps1',
        consultationId: 'c1',
        type: 'pre_summary',
        content: 'Pre-summary',
        createdAt: new Date().toISOString(),
      } as unknown as SummaryResponse;

      useAgenticStore.getState().setSummaries([preSummary]);

      const state = useAgenticStore.getState();
      const result = selectLatestPreSummary(state);

      expect(result?.id).toBe('ps1');
    });

    it('selectLatestSummary should return null when no summaries', () => {
      useAgenticStore.getState().setSummaries([]);

      const state = useAgenticStore.getState();
      expect(selectLatestSummary(state)).toBeNull();
    });

    it('selectLatestPreSummary should return null when no pre-summaries exist', () => {
      const onlySummary = {
        id: 'only-s',
        consultationId: 'c1',
        type: 'summary',
        content: 'Only summary',
        createdAt: new Date().toISOString(),
      } as unknown as SummaryResponse;

      useAgenticStore.getState().setSummaries([onlySummary]);

      const state = useAgenticStore.getState();
      expect(selectLatestPreSummary(state)).toBeNull();
    });

    it('selectLatestPreSummary should return last when multiple pre-summaries exist', () => {
      const ps1 = {
        id: 'ps1',
        consultationId: 'c1',
        type: 'pre_summary',
        content: 'First pre',
        createdAt: new Date().toISOString(),
      } as unknown as SummaryResponse;
      const ps2 = {
        id: 'ps2',
        consultationId: 'c1',
        type: 'pre_summary',
        content: 'Second pre',
        createdAt: new Date().toISOString(),
      } as unknown as SummaryResponse;

      useAgenticStore.getState().setSummaries([ps1, ps2]);

      expect(selectLatestPreSummary(useAgenticStore.getState())?.id).toBe('ps2');
    });

    it('selectSummaryItems should include both summary and pre_summary types', () => {
      const preSummaryItem = {
        id: '4',
        consultationId: 'c1',
        type: 'pre_summary',
        content: 'Pre-summary',
        createdAt: new Date().toISOString(),
      } as unknown as ContextItem;
      useAgenticStore.getState().addContextItem(preSummaryItem);

      const state = useAgenticStore.getState();
      const result = selectSummaryItems(state);

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.type)).toContain('summary');
      expect(result.map((i) => i.type)).toContain('pre_summary');
    });
  });

  describe('initialize with config and preferences', () => {
    it('should store config from initialize call', () => {
      const mockConfig = {
        api: { baseUrl: 'http://example.com', apiKey: 'k' },
        audio: { enabled: true },
      };
      const mockPrefManager = {
        getPreferences: () => ({ theme: 'dark', language: 'fr' }),
      } as any;

      useAgenticStore.getState().initialize(mockConfig as any, {} as any, {} as any, mockPrefManager, {} as any, {} as any);

      const state = useAgenticStore.getState();
      expect(state.config).toBe(mockConfig);
      expect(state.preferences).toEqual({ theme: 'dark', language: 'fr' });
    });

    it('should store all managers during initialize', () => {
      const apiClient = { get: vi.fn() } as any;
      const pluginManager = { register: vi.fn() } as any;
      const prefManager = { getPreferences: () => ({}) } as any;
      const modelRegistry = { load: vi.fn() } as any;
      const logger = { info: vi.fn() } as any;

      useAgenticStore
        .getState()
        .initialize({ api: { baseUrl: 'http://x', apiKey: 'y' } } as any, apiClient, pluginManager, prefManager, modelRegistry, logger);

      const state = useAgenticStore.getState();
      expect(state.pluginManager).toBe(pluginManager);
      expect(state.personalizationManager).toBe(prefManager);
      expect(state.modelRegistry).toBe(modelRegistry);
      expect(state.logger).toBe(logger);
    });
  });

  describe('pipeline state selectors', () => {
    it('selectTranscriptionPipelineState should return null initially', () => {
      const state = useAgenticStore.getState();
      expect(selectTranscriptionPipelineState(state)).toBeNull();
    });

    it('selectKnowledgePipelineState should return null initially', () => {
      const state = useAgenticStore.getState();
      expect(selectKnowledgePipelineState(state)).toBeNull();
    });

    it('setTranscriptionPipelineState should update the state', () => {
      const pipelineState = {
        status: 'running',
        currentStage: 'vad',
        progress: 50,
        isReady: true,
      } as unknown as PipelineStateInfo;

      useAgenticStore.getState().setTranscriptionPipelineState(pipelineState);

      const state = useAgenticStore.getState();
      expect(selectTranscriptionPipelineState(state)).toEqual(pipelineState);
      expect(state.transcriptionPipelineState?.currentStage).toBe('vad');
      expect(state.transcriptionPipelineState?.progress).toBe(50);
    });

    it('setKnowledgePipelineState should update the state', () => {
      const pipelineState = {
        status: 'idle',
        progress: 0,
        isReady: true,
      } as unknown as PipelineStateInfo;

      useAgenticStore.getState().setKnowledgePipelineState(pipelineState);

      const state = useAgenticStore.getState();
      expect(selectKnowledgePipelineState(state)).toEqual(pipelineState);
      expect(state.knowledgePipelineState?.status).toBe('idle');
    });

    it('should clear pipeline state when set to null', () => {
      const running = {
        status: 'running',
        progress: 75,
        isReady: true,
      } as unknown as PipelineStateInfo;

      useAgenticStore.getState().setTranscriptionPipelineState(running);
      expect(selectTranscriptionPipelineState(useAgenticStore.getState())).not.toBeNull();

      useAgenticStore.getState().setTranscriptionPipelineState(null);
      expect(selectTranscriptionPipelineState(useAgenticStore.getState())).toBeNull();
    });
  });

  describe('setSummaries action', () => {
    it('should replace all existing summaries', () => {
      const s1 = {
        id: 'old-1',
        consultationId: 'c1',
        type: 'summary',
        content: 'Old',
        createdAt: new Date().toISOString(),
      } as unknown as SummaryResponse;

      useAgenticStore.getState().setSummaries([s1]);
      expect(useAgenticStore.getState().summaries).toHaveLength(1);

      const s2 = {
        id: 'new-1',
        consultationId: 'c1',
        type: 'pre_summary',
        content: 'New 1',
        createdAt: new Date().toISOString(),
      } as unknown as SummaryResponse;
      const s3 = {
        id: 'new-2',
        consultationId: 'c1',
        type: 'summary',
        content: 'New 2',
        createdAt: new Date().toISOString(),
      } as unknown as SummaryResponse;

      useAgenticStore.getState().setSummaries([s2, s3]);

      const summaries = useAgenticStore.getState().summaries;
      expect(summaries).toHaveLength(2);
      expect(summaries[0].id).toBe('new-1');
      expect(summaries[1].id).toBe('new-2');
    });

    it('should allow setting empty summaries array', () => {
      const s1 = {
        id: 'x',
        consultationId: 'c1',
        type: 'summary',
        content: 'C',
        createdAt: new Date().toISOString(),
      } as unknown as SummaryResponse;

      useAgenticStore.getState().setSummaries([s1]);
      useAgenticStore.getState().setSummaries([]);

      expect(useAgenticStore.getState().summaries).toEqual([]);
    });
  });

  describe('setAudioError action', () => {
    it('should set an audio error', () => {
      const error = new Error('Microphone access denied');

      useAgenticStore.getState().setAudioError(error);

      expect(useAgenticStore.getState().audioError).toBe(error);
      expect(useAgenticStore.getState().audioError?.message).toBe('Microphone access denied');
    });

    it('should clear audio error when set to null', () => {
      useAgenticStore.getState().setAudioError(new Error('Temporary'));
      expect(useAgenticStore.getState().audioError).not.toBeNull();

      useAgenticStore.getState().setAudioError(null);

      expect(useAgenticStore.getState().audioError).toBeNull();
    });
  });

  describe('selectIsAudioSource selector', () => {
    it('should return false initially', () => {
      expect(selectIsAudioSource(useAgenticStore.getState())).toBe(false);
    });

    it('should return true after setIsAudioSource(true)', () => {
      useAgenticStore.getState().setIsAudioSource(true);

      expect(selectIsAudioSource(useAgenticStore.getState())).toBe(true);
    });
  });

  describe('cross-tab actions', () => {
    it('should set audio source tab ID', () => {
      useAgenticStore.getState().setAudioSourceTabId('tab-abc-123');

      expect(useAgenticStore.getState().audioSourceTabId).toBe('tab-abc-123');
    });

    it('should clear audio source tab ID', () => {
      useAgenticStore.getState().setAudioSourceTabId('tab-123');
      useAgenticStore.getState().setAudioSourceTabId(null);

      expect(useAgenticStore.getState().audioSourceTabId).toBeNull();
    });
  });

  describe('context edge cases', () => {
    it('updateContextItem should not modify items with different IDs', () => {
      const item1 = {
        id: 'a',
        consultationId: 'c1',
        type: 'transcription',
        content: 'Original A',
        createdAt: new Date().toISOString(),
      } as unknown as ContextItem;
      const item2 = {
        id: 'b',
        consultationId: 'c1',
        type: 'case_note',
        content: 'Original B',
        createdAt: new Date().toISOString(),
      } as unknown as ContextItem;

      useAgenticStore.getState().setContextItems([item1, item2]);
      useAgenticStore.getState().updateContextItem('a', { content: 'Updated A' });

      const items = useAgenticStore.getState().contextItems;
      expect(items.find((i) => i.id === 'a')?.content).toBe('Updated A');
      expect(items.find((i) => i.id === 'b')?.content).toBe('Original B');
    });

    it('removeContextItem with non-existent ID should not change array', () => {
      const item = {
        id: 'keep-me',
        consultationId: 'c1',
        type: 'transcription',
        content: 'Stay',
        createdAt: new Date().toISOString(),
      } as unknown as ContextItem;

      useAgenticStore.getState().setContextItems([item]);
      useAgenticStore.getState().removeContextItem('does-not-exist');

      expect(useAgenticStore.getState().contextItems).toHaveLength(1);
      expect(useAgenticStore.getState().contextItems[0].id).toBe('keep-me');
    });

    it('clearContext should also reset contextError to null', () => {
      useAgenticStore.getState().setContextError(new Error('Some context error'));
      expect(useAgenticStore.getState().contextError).not.toBeNull();

      useAgenticStore.getState().clearContext();

      expect(useAgenticStore.getState().contextError).toBeNull();
    });

    it('setContextLoading and setContextError should update independently', () => {
      useAgenticStore.getState().setContextLoading(true);
      useAgenticStore.getState().setContextError(new Error('Oops'));

      const state = useAgenticStore.getState();
      expect(state.contextLoading).toBe(true);
      expect(state.contextError?.message).toBe('Oops');
    });
  });

  describe('summary error actions', () => {
    it('should set summary error', () => {
      const error = new Error('Summary generation failed');

      useAgenticStore.getState().setSummaryError(error);

      expect(useAgenticStore.getState().summaryError).toBe(error);
    });

    it('should clear summary error', () => {
      useAgenticStore.getState().setSummaryError(new Error('fail'));
      useAgenticStore.getState().setSummaryError(null);

      expect(useAgenticStore.getState().summaryError).toBeNull();
    });
  });

  describe('global error actions', () => {
    it('should set global error', () => {
      const error = new Error('Critical SDK failure');

      useAgenticStore.getState().setGlobalError(error);

      expect(useAgenticStore.getState().globalError).toBe(error);
    });

    it('should clear global error', () => {
      useAgenticStore.getState().setGlobalError(new Error('bad'));
      useAgenticStore.getState().setGlobalError(null);

      expect(useAgenticStore.getState().globalError).toBeNull();
    });
  });

  describe('addSummary deduplication', () => {
    const baseSummary = {
      id: 'summary-dedup',
      consultationId: 'c1',
      type: 'summary',
      content: 'Original',
      createdAt: new Date().toISOString(),
    } as unknown as SummaryResponse;

    it('should not duplicate when adding summary with same id', () => {
      useAgenticStore.getState().addSummary(baseSummary);
      useAgenticStore.getState().addSummary({ ...baseSummary, content: 'Updated' });

      const summaries = useAgenticStore.getState().summaries;
      expect(summaries).toHaveLength(1);
      expect(summaries[0].content).toBe('Updated');
    });

    it('should add summary with different id normally', () => {
      useAgenticStore.getState().addSummary(baseSummary);
      useAgenticStore.getState().addSummary({ ...baseSummary, id: 'summary-other', content: 'Other' });

      expect(useAgenticStore.getState().summaries).toHaveLength(2);
    });
  });

  describe('addEntities deduplication', () => {
    it('should not duplicate entities with the same id', () => {
      const entity1 = { id: 'ent-1', type: 'medication', text: 'Aspirin' } as any;
      const entity2 = { id: 'ent-2', type: 'condition', text: 'Headache' } as any;

      useAgenticStore.getState().addEntities([entity1, entity2]);
      useAgenticStore.getState().addEntities([{ ...entity1, text: 'Aspirin Updated' }]);

      const entities = useAgenticStore.getState().entities;
      expect(entities).toHaveLength(2);
      expect(entities.find((e: any) => e.id === 'ent-1')?.text).toBe('Aspirin Updated');
    });

    it('should add new entities alongside existing ones', () => {
      const entity1 = { id: 'ent-1', type: 'medication', text: 'Aspirin' } as any;
      const entity3 = { id: 'ent-3', type: 'procedure', text: 'MRI' } as any;

      useAgenticStore.getState().addEntities([entity1]);
      useAgenticStore.getState().addEntities([entity3]);

      expect(useAgenticStore.getState().entities).toHaveLength(2);
    });
  });

  describe('addContextItem deduplication', () => {
    it('should not duplicate context items with the same id', () => {
      const item = {
        id: 'ctx-1',
        consultationId: 'c1',
        type: 'transcription',
        content: 'Original',
        createdAt: new Date().toISOString(),
      } as unknown as ContextItem;

      useAgenticStore.getState().addContextItem(item);
      useAgenticStore.getState().addContextItem({ ...item, content: 'Updated' });

      const items = useAgenticStore.getState().contextItems;
      expect(items).toHaveLength(1);
      expect(items[0].content).toBe('Updated');
    });
  });

  describe('reset preserves preferences', () => {
    it('should keep preferences across reset', () => {
      const mockPrefManager = {
        getPreferences: () => ({ theme: 'dark' }),
      } as any;

      useAgenticStore
        .getState()
        .initialize({ api: { baseUrl: 'http://x', apiKey: 'k' } } as any, {} as any, {} as any, mockPrefManager, {} as any, {} as any);

      useAgenticStore.getState().updatePreferences({ language: 'es' });
      useAgenticStore.getState().setConsultation({ id: 'will-be-reset' } as any);
      useAgenticStore.getState().setIsCapturing(true);

      useAgenticStore.getState().reset();

      const state = useAgenticStore.getState();
      expect(state.consultation).toBeNull();
      expect(state.isCapturing).toBe(false);
      expect(state.preferences).toEqual({ theme: 'dark', language: 'es' });
      expect(state.config).not.toBeNull();
    });
  });

  // =========================================================================
  // SEC-04: clearSensitiveData
  // =========================================================================

  describe('SEC-04: clearSensitiveData', () => {
    it('should clear all PHI/PII data while preserving SDK infrastructure', () => {
      useAgenticStore.getState().setConsultation({ id: 'consult-1', patientId: 'p-1' } as any);
      useAgenticStore.getState().setContextItems([{ id: 'ctx-1', text: 'patient data' } as any]);
      useAgenticStore.getState().setEntities([{ id: 'ent-1', text: 'diagnosis' } as any]);
      useAgenticStore.getState().setSummaries([{ id: 'sum-1', text: 'summary' } as any]);
      useAgenticStore.getState().setTranscriptSegments([{ id: 'seg-1', text: 'transcript' } as any]);
      useAgenticStore.getState().setCurrentTranscript('some transcript text');

      useAgenticStore.getState().clearSensitiveData();

      const state = useAgenticStore.getState();
      expect(state.consultation).toBeNull();
      expect(state.contextItems).toEqual([]);
      expect(state.sharedContext).toEqual([]);
      expect(state.entities).toEqual([]);
      expect(state.summaries).toEqual([]);
      expect(state.transcriptSegments).toEqual([]);
      expect(state.currentTranscript).toBe('');
      // Infrastructure should be preserved
      expect(state.initialized).toBe(false);
      expect(state.config).toBeNull();
    });
  });

  // =========================================================================
  // clearOnLogout is scoped to the OUTGOING namespace.
  //
  // CONTRACT INVERSION (was ENH-07 / audit C-2): clearOnLogout previously
  // swept EVERY `arcaai-user-preferences/*` key and wholesale-cleared the IDB
  // stores, wiping OTHER tenants'/users' browser data on a shared workstation.
  // It now removes ONLY the outgoing `arcaai-user-preferences/${ns}`
  // localStorage key and the `arcaai-personalization/${ns}` IDB row. The
  // assertions below were rewritten (not extended) to lock in that scoping —
  // tenant-B's data MUST survive tenant-A's logout.
  // =========================================================================

  describe('clearOnLogout outgoing-namespace scoping', () => {
    it('removes ONLY the outgoing namespace localStorage key, leaving other tenants intact', () => {
      localStorage.setItem('arcaai-user-preferences/t1::u1', '{"lang":"en"}');
      localStorage.setItem('arcaai-user-preferences/t2::u2', '{"lang":"th"}');
      localStorage.setItem('unrelated-key', 'keep-me');

      useAgenticStore.getState().clearOnLogout('t1::u1');

      // Outgoing tenant/user key is gone...
      expect(localStorage.getItem('arcaai-user-preferences/t1::u1')).toBeNull();
      // ...but tenant B's namespaced data SURVIVES (the old C-2 sweep wiped it).
      expect(localStorage.getItem('arcaai-user-preferences/t2::u2')).toBe('{"lang":"th"}');
      expect(localStorage.getItem('unrelated-key')).toBe('keep-me');
    });

    it('does NOT iterate-and-delete every arcaai-user-preferences/* key or touch legacy globals', () => {
      localStorage.setItem('arcaai-preferences', '{"theme":"dark"}');
      localStorage.setItem('arcaai-selected-models', '{"stt":"m1"}');
      localStorage.setItem('arcaai-user-preferences/t2::u2', '{"lang":"th"}');

      useAgenticStore.getState().clearOnLogout('t1::u1');

      // No wholesale sweep — a different tenant's namespaced key survives.
      expect(localStorage.getItem('arcaai-user-preferences/t2::u2')).toBe('{"lang":"th"}');
      // Legacy global keys are no longer this action's concern (the v3
      // configDB upgrade handles the legacy personalization row).
      expect(localStorage.getItem('arcaai-preferences')).toBe('{"theme":"dark"}');
      expect(localStorage.getItem('arcaai-selected-models')).toBe('{"stt":"m1"}');
    });

    it('deletes ONLY the outgoing namespace personalization IDB row, never a wholesale .clear()', () => {
      useAgenticStore.getState().clearOnLogout('t1::u1');

      expect(configDBDelete).toHaveBeenCalledWith('personalization', 'arcaai-personalization/t1::u1');
      expect(configDBDelete).not.toHaveBeenCalledWith('personalization', 'arcaai-personalization/t2::u2');
      expect(configDBClear).not.toHaveBeenCalled();
    });

    // clearOnLogout still drops the in-memory personalization tier.
    it('clearOnLogout resets the personalization tier', () => {
      useAgenticStore.setState({
        preferences: { language: 'th' } as unknown as never,
        tenantConfig: { defaultSttModel: 'whisper-base' } as unknown as never,
        resolvedConfig: { stt: { language: 'th' } } as unknown as never,
        configReady: true,
        profileReady: true,
        configManager: { fake: true } as unknown as never,
        personalizationManager: { fake: true } as unknown as never,
      });

      useAgenticStore.getState().clearOnLogout('t1::u1');

      const s = useAgenticStore.getState();
      expect(s.preferences).toEqual({});
      expect(s.tenantConfig).toBeNull();
      expect(s.resolvedConfig).toBeNull();
      expect(s.configReady).toBe(false);
      expect(s.profileReady).toBe(false);
      expect(s.configManager).toBeNull();
      expect(s.personalizationManager).toBeNull();
    });

    it('should also clear sensitive in-memory state', () => {
      useAgenticStore.getState().addContextItem({
        id: 'ctx-1',
        type: 'transcription',
        content: 'test',
        timestamp: Date.now(),
      } as unknown as ContextItem);

      useAgenticStore.getState().clearOnLogout('t1::u1');

      const state = useAgenticStore.getState();
      expect(state.contextItems).toEqual([]);
      expect(state.consultation).toBeNull();
      expect(state.authUser).toBeNull();
      expect(state.authIsAuthenticated).toBe(false);
    });
  });

  // =========================================================================
  // ENH-05: Hot config reload (non-destructive updates)
  // =========================================================================

  describe('ENH-05: updateRuntimeConfig', () => {
    it('should update log level without full re-initialization', () => {
      const mockLogger = {
        setLevel: vi.fn(),
        getLevel: vi.fn().mockReturnValue('info'),
        child: vi.fn().mockReturnValue(null),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        http: vi.fn(),
        trace: vi.fn(),
        initialize: vi.fn().mockResolvedValue(undefined),
        flush: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn(),
        getCorrelationId: vi.fn(),
        getTransportNames: vi.fn().mockReturnValue([]),
        startOperation: vi.fn(),
      };

      useAgenticStore.setState({ logger: mockLogger as any, initialized: true });

      useAgenticStore.getState().updateRuntimeConfig({ logLevel: 'debug' });

      expect(mockLogger.setLevel).toHaveBeenCalledWith('debug');
    });

    it('should not crash when logger is null', () => {
      useAgenticStore.setState({ logger: null, initialized: true });

      expect(() => {
        useAgenticStore.getState().updateRuntimeConfig({ logLevel: 'debug' });
      }).not.toThrow();
    });
  });

  // =========================================================================
  // Granular selectors for performance
  // =========================================================================

  describe('activeStream/activeAudioContext', () => {
    it('should have null initial values for activeStream and activeAudioContext', () => {
      const state = useAgenticStore.getState();
      expect(state.activeStream).toBeNull();
      expect(state.activeAudioContext).toBeNull();
    });

    it('should set and clear activeStream', () => {
      const mockStream = { id: 'mock-stream', active: true } as unknown as MediaStream;
      useAgenticStore.getState().setActiveStream(mockStream);
      expect(useAgenticStore.getState().activeStream).toBe(mockStream);

      useAgenticStore.getState().setActiveStream(null);
      expect(useAgenticStore.getState().activeStream).toBeNull();
    });

    it('should set and clear activeAudioContext', () => {
      const mockCtx = {} as AudioContext;
      useAgenticStore.getState().setActiveAudioContext(mockCtx);
      expect(useAgenticStore.getState().activeAudioContext).toBe(mockCtx);

      useAgenticStore.getState().setActiveAudioContext(null);
      expect(useAgenticStore.getState().activeAudioContext).toBeNull();
    });

    it('should clear activeStream and activeAudioContext on clearSensitiveData', () => {
      const mockStream = { id: 'mock-stream', active: true } as unknown as MediaStream;
      const mockCtx = {} as AudioContext;
      useAgenticStore.getState().setActiveStream(mockStream);
      useAgenticStore.getState().setActiveAudioContext(mockCtx);

      useAgenticStore.getState().clearSensitiveData();

      expect(useAgenticStore.getState().activeStream).toBeNull();
      expect(useAgenticStore.getState().activeAudioContext).toBeNull();
    });
  });

  describe('granular selectors', () => {
    it('selectConsultation should return only the consultation field', () => {
      const mockConsultation = { id: 'c-1', status: 'active' };
      useAgenticStore.setState({ consultation: mockConsultation as any });

      const result = selectConsultation(useAgenticStore.getState());
      expect(result).toEqual(mockConsultation);
    });

    it('selectIsCapturing should return only the isCapturing boolean', () => {
      useAgenticStore.setState({ isCapturing: true });

      const result = selectIsCapturing(useAgenticStore.getState());
      expect(result).toBe(true);
    });

    it('selectAudioLevel should return only the audioLevel number', () => {
      useAgenticStore.setState({ audioLevel: 0.75 });

      const result = selectAudioLevel(useAgenticStore.getState());
      expect(result).toBe(0.75);
    });

    it('selectEntities should return only the entities array', () => {
      const entities = [{ id: 'e-1', text: 'diabetes', type: 'CONDITION' }];
      useAgenticStore.setState({ entities: entities as any });

      const result = selectEntities(useAgenticStore.getState());
      expect(result).toEqual(entities);
    });

    it('selectSummaries should return only the summaries array', () => {
      const summaries = [{ id: 's-1', type: 'summary', content: 'test' }];
      useAgenticStore.setState({ summaries: summaries as any });

      const result = selectSummaries(useAgenticStore.getState());
      expect(result).toEqual(summaries);
    });
  });

  // =========================================================================
  // Three-tier config management
  // =========================================================================

  describe('config management actions and selectors', () => {
    it('should have null configManager initially', () => {
      expect(selectConfigManager(useAgenticStore.getState())).toBeNull();
    });

    it('should have null resolvedConfig initially', () => {
      expect(selectResolvedConfig(useAgenticStore.getState())).toBeNull();
    });

    it('should have configReady false initially', () => {
      expect(selectConfigReady(useAgenticStore.getState())).toBe(false);
    });

    it('should set configManager', () => {
      const mockManager = { getResolved: vi.fn() } as any;
      useAgenticStore.getState().setConfigManager(mockManager);
      expect(selectConfigManager(useAgenticStore.getState())).toBe(mockManager);
    });

    it('should set resolvedConfig', () => {
      const mockConfig = {
        audio: { sampleRate: 16000 },
        stt: { language: 'en' },
      } as any;
      useAgenticStore.getState().setResolvedConfig(mockConfig);
      expect(selectResolvedConfig(useAgenticStore.getState())).toBe(mockConfig);
    });

    it('should set configReady to true', () => {
      useAgenticStore.getState().setConfigReady(true);
      expect(selectConfigReady(useAgenticStore.getState())).toBe(true);
    });

    it('should set configReady back to false', () => {
      useAgenticStore.getState().setConfigReady(true);
      useAgenticStore.getState().setConfigReady(false);
      expect(selectConfigReady(useAgenticStore.getState())).toBe(false);
    });

    it('should preserve configManager and resolvedConfig across reset', () => {
      const mockManager = { getResolved: vi.fn() } as any;
      const mockConfig = { audio: { sampleRate: 16000 } } as any;
      useAgenticStore.getState().setConfigManager(mockManager);
      useAgenticStore.getState().setResolvedConfig(mockConfig);
      useAgenticStore.getState().setConfigReady(true);

      useAgenticStore.getState().reset();

      // Reset restores initial state except managers
      // configManager/resolvedConfig/configReady are not in the "keep" list of reset()
      const state = useAgenticStore.getState();
      expect(state.configManager).toBeNull();
      expect(state.resolvedConfig).toBeNull();
      expect(state.configReady).toBe(false);
    });
  });

  // =========================================================================
  // SDK audio-drop surfacing (C6-01 sibling)
  //
  // The streaming provider counts backpressure drops; the SDK path pushes them
  // up to the store so the vox UI can render a degraded-connection signal. The
  // `audioLostThisSession` latch is session-sticky: it survives reconnect and
  // clears ONLY on start/stop, so a transient reset never
  // erases the "audio was lost" signal exactly when loss happened.
  // =========================================================================

  describe('streaming STT connection state', () => {
    it('starts nominal with no active pipeline', () => {
      const state = useAgenticStore.getState();
      expect(state.sttConnectionState).toBe('connected');
      expect(state.activePipeline).toBeNull();
    });

    it('setSttConnectionState updates the connection health', () => {
      useAgenticStore.getState().setSttConnectionState('reconnecting');
      expect(useAgenticStore.getState().sttConnectionState).toBe('reconnecting');

      useAgenticStore.getState().setSttConnectionState('switched_fallback');
      expect(useAgenticStore.getState().sttConnectionState).toBe('switched_fallback');
    });

    it('setActivePipeline sets and clears the active pipeline descriptor', () => {
      useAgenticStore.getState().setActivePipeline({ id: 'fallback', name: 'Fallback', isFallback: true });
      expect(useAgenticStore.getState().activePipeline).toEqual({ id: 'fallback', name: 'Fallback', isFallback: true });

      useAgenticStore.getState().setActivePipeline(null);
      expect(useAgenticStore.getState().activePipeline).toBeNull();
    });

    it('clearTenantSessionData resets the connection state and active pipeline', () => {
      useAgenticStore.getState().setSttConnectionState('switched_fallback');
      useAgenticStore.getState().setActivePipeline({ id: 'x', name: 'x', isFallback: true });

      useAgenticStore.getState().clearTenantSessionData();

      const state = useAgenticStore.getState();
      expect(state.sttConnectionState).toBe('connected');
      expect(state.activePipeline).toBeNull();
    });
  });

  describe('audio-drop state', () => {
    it('starts with a zero drop count and an un-set loss latch', () => {
      const state = useAgenticStore.getState();
      expect(state.audioDroppedFrameCount).toBe(0);
      expect(state.audioLostThisSession).toBe(false);
    });

    it('incrementDroppedFrames bumps the count by one each call', () => {
      useAgenticStore.getState().incrementDroppedFrames();
      useAgenticStore.getState().incrementDroppedFrames();

      expect(useAgenticStore.getState().audioDroppedFrameCount).toBe(2);
    });

    it('markAudioLost latches audioLostThisSession true', () => {
      useAgenticStore.getState().markAudioLost();

      expect(useAgenticStore.getState().audioLostThisSession).toBe(true);
    });

    it('resetAudioDropped clears both the count and the latch (start/stop)', () => {
      useAgenticStore.getState().incrementDroppedFrames();
      useAgenticStore.getState().markAudioLost();

      useAgenticStore.getState().resetAudioDropped();

      const state = useAgenticStore.getState();
      expect(state.audioDroppedFrameCount).toBe(0);
      expect(state.audioLostThisSession).toBe(false);
    });

    it('selectAudioDropped returns the running drop count', () => {
      useAgenticStore.getState().incrementDroppedFrames();
      useAgenticStore.getState().incrementDroppedFrames();
      useAgenticStore.getState().incrementDroppedFrames();

      expect(selectAudioDropped(useAgenticStore.getState())).toBe(3);
    });

    it('selectAudioDegraded reflects the session-sticky loss latch', () => {
      expect(selectAudioDegraded(useAgenticStore.getState())).toBe(false);

      useAgenticStore.getState().markAudioLost();

      expect(selectAudioDegraded(useAgenticStore.getState())).toBe(true);
    });

    it('clearTenantSessionData resets the audio-drop signal (tenant switch)', () => {
      useAgenticStore.getState().incrementDroppedFrames();
      useAgenticStore.getState().markAudioLost();

      useAgenticStore.getState().clearTenantSessionData();

      const state = useAgenticStore.getState();
      expect(state.audioDroppedFrameCount).toBe(0);
      expect(state.audioLostThisSession).toBe(false);
    });

    it('clearSensitiveData resets the audio-drop signal (security wipe)', () => {
      useAgenticStore.getState().incrementDroppedFrames();
      useAgenticStore.getState().markAudioLost();

      useAgenticStore.getState().clearSensitiveData();

      const state = useAgenticStore.getState();
      expect(state.audioDroppedFrameCount).toBe(0);
      expect(state.audioLostThisSession).toBe(false);
    });

    it('reset() clears the audio-drop signal', () => {
      useAgenticStore.getState().incrementDroppedFrames();
      useAgenticStore.getState().markAudioLost();

      useAgenticStore.getState().reset();

      const state = useAgenticStore.getState();
      expect(state.audioDroppedFrameCount).toBe(0);
      expect(state.audioLostThisSession).toBe(false);
    });
  });
});
