/**
 * useArca Hook — API Happy-Path Tests
 *
 * Tests that verify every business-logic method of useArca actually calls the
 * correct endpoint, updates the store, and returns the expected value when a
 * real AgenticClient is wired up (with a mocked global fetch).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArca } from '../useArca';
import { useAgenticStore } from '../../store';
import { AgenticClient } from '../../core/AgenticClient';
import {
  createMockLogger,
  mockFetch,
  createMockResponse,
  createMockConsultation,
  createMockContextItem,
  createMockSummary,
} from '../../__tests__/setup';

// ---------------------------------------------------------------------------
// Store mock — returns a mutable object that tests can configure per-case
// ---------------------------------------------------------------------------

vi.mock('../../store', () => {
  const mockStore: Record<string, unknown> = {};
  return {
    useAgenticStore: vi.fn(() => mockStore),
    selectTranscriptions: vi.fn(() => []),
    selectCaseNotes: vi.fn(() => []),
    selectIsAudioSource: vi.fn(() => false),
    selectTranscriptionPipelineState: vi.fn(() => null),
    selectKnowledgePipelineState: vi.fn(() => null),
  };
});

// diffUtils is imported by the hook for compareSummaryVersions
vi.mock('../../utils/diffUtils', () => ({
  computeSummaryDiff: vi.fn((a: string, b: string) => ({
    changes: [{ value: a }, { value: b, added: true }],
    patch: '',
    stats: { additions: 1, deletions: 0, unchanged: 1 },
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mockStoreData: Record<string, any>;
let mockLogger: ReturnType<typeof createMockLogger>;
let apiClient: AgenticClient;

function calledUrl(callIndex = 0): string {
  const args = mockFetch.mock.calls[callIndex];
  return args?.[0] ?? '';
}

function calledMethod(callIndex = 0): string {
  return mockFetch.mock.calls[callIndex]?.[1]?.method ?? 'GET';
}

function calledBody(callIndex = 0): unknown {
  const raw = mockFetch.mock.calls[callIndex]?.[1]?.body;
  return raw ? JSON.parse(raw as string) : undefined;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockLogger = createMockLogger();
  apiClient = new AgenticClient(
    { baseUrl: 'http://test', apiKey: 'test-key' },
    mockLogger,
  );

  mockStoreData = {
    apiClient,
    consultation: createMockConsultation({ id: 'cons-1', patientId: 'p1' }),
    relatedConsultations: [],
    contextItems: [],
    entities: [],
    sharedContext: [],
    summaries: [],
    dnaStyle: null,
    preferences: {},

    sessionLoading: false,
    sessionError: null,
    contextLoading: false,
    contextError: null,
    summaryGenerating: false,
    summaryError: null,
    audioError: null,

    isCapturing: false,
    isMuted: false,
    audioLevel: 0,
    isSpeaking: false,
    currentTranscript: '',
    audioPlugins: {
      noiseFilter: { isActive: false, isInitialized: false },
      vad: { isActive: false, isInitialized: false },
      stt: { isActive: false, isInitialized: false, provider: 'auto' },
    },

    initialized: true,
    globalError: null,
    logger: mockLogger,
    pluginManager: null,

    transcriptionPipelineState: null,
    knowledgePipelineState: null,
    isAudioSource: false,
    audioSourceTabId: null,

    // Store actions
    setSessionLoading: vi.fn(),
    setSessionError: vi.fn(),
    setConsultation: vi.fn(),
    setRelatedConsultations: vi.fn(),
    clearContext: vi.fn(),
    addContextItem: vi.fn(),
    updateContextItem: vi.fn(),
    setContextLoading: vi.fn(),
    setContextError: vi.fn(),
    setSharedContext: vi.fn(),
    setEntities: vi.fn(),
    addEntities: vi.fn(),
    setSummaryGenerating: vi.fn(),
    setSummaryError: vi.fn(),
    addSummary: vi.fn(),
    setSummaries: vi.fn(),
    setDNAStyle: vi.fn(),
    setIsCapturing: vi.fn(),
    setIsMuted: vi.fn(),
    setAudioLevel: vi.fn(),
    setIsSpeaking: vi.fn(),
    setCurrentTranscript: vi.fn(),
    setAudioPlugins: vi.fn(),
    setAudioError: vi.fn(),
    reset: vi.fn(),
  };

  (useAgenticStore as any).mockReturnValue(mockStoreData);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// SESSION
// ===========================================================================

describe('useArca API — session', () => {
  // ---- session.open -------------------------------------------------------
  describe('session.open()', () => {
    it('should POST to /consultations/open and store the consultation', async () => {
      const consultation = createMockConsultation({ id: 'new-cons', isNew: true });
      mockFetch.mockResolvedValueOnce(createMockResponse(consultation));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.session.open({
          patientId: 'p1',
          appointmentDate: '2026-02-19',
        });
      });

      expect(calledUrl()).toBe('http://test/consultations/open');
      expect(calledMethod()).toBe('POST');
      expect(calledBody()).toMatchObject({ patientId: 'p1', appointmentDate: '2026-02-19' });
      expect(mockStoreData.setConsultation).toHaveBeenCalledWith(consultation);
      expect(mockStoreData.clearContext).toHaveBeenCalled();
      expect(returned.id).toBe('new-cons');
    });

    it('should load contextItems from the returned consultation', async () => {
      const ctxItems = [
        createMockContextItem({ id: 'ci-1' }),
        createMockContextItem({ id: 'ci-2' }),
      ];
      const consultation = createMockConsultation({ id: 'with-ctx', contextItems: ctxItems });
      mockFetch.mockResolvedValueOnce(createMockResponse(consultation));

      const { result } = renderHook(() => useArca());
      await act(async () => {
        await result.current.session.open({ patientId: 'p1', appointmentDate: '2026-02-19' });
      });

      expect(mockStoreData.addContextItem).toHaveBeenCalledTimes(2);
      expect(mockStoreData.addContextItem).toHaveBeenCalledWith(ctxItems[0]);
      expect(mockStoreData.addContextItem).toHaveBeenCalledWith(ctxItems[1]);
    });

    it('should toggle loading flag via setSessionLoading', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockConsultation()));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.session.open({ patientId: 'p1', appointmentDate: '2026-02-19' });
      });

      const calls = mockStoreData.setSessionLoading.mock.calls;
      expect(calls[0][0]).toBe(true);
      expect(calls[calls.length - 1][0]).toBe(false);
    });
  });

  // ---- session.load -------------------------------------------------------
  describe('session.load()', () => {
    it('should GET /consultations/:id and store the consultation', async () => {
      const consultation = createMockConsultation({ id: 'loaded-1' });
      mockFetch.mockResolvedValueOnce(createMockResponse(consultation));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.session.load('loaded-1');
      });

      expect(calledUrl()).toBe('http://test/consultations/loaded-1');
      expect(calledMethod()).toBe('GET');
      expect(mockStoreData.setConsultation).toHaveBeenCalledWith(consultation);
      expect(mockStoreData.clearContext).toHaveBeenCalled();
      expect(returned.id).toBe('loaded-1');
    });
  });

  // ---- session.findByPatientDate ------------------------------------------
  describe('session.findByPatientDate()', () => {
    it('should GET /consultations/patient/:id/date/:date', async () => {
      const consultations = [createMockConsultation({ id: 'c1' })];
      mockFetch.mockResolvedValueOnce(createMockResponse(consultations));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.session.findByPatientDate('p1', '2026-02-19');
      });

      expect(calledUrl()).toBe('http://test/consultations/patient/p1/date/2026-02-19');
      expect(calledMethod()).toBe('GET');
      expect(returned).toHaveLength(1);
    });
  });

  // ---- session.getPatientHistory ------------------------------------------
  describe('session.getPatientHistory()', () => {
    it('should GET patient history without pagination', async () => {
      const history = [createMockConsultation({ id: 'h1' }), createMockConsultation({ id: 'h2' })];
      mockFetch.mockResolvedValueOnce(createMockResponse(history));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.session.getPatientHistory('p1');
      });

      expect(calledUrl()).toBe('http://test/consultations/patient/p1/history');
      expect(returned).toHaveLength(2);
    });

    it('should append pagination query params when provided', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.session.getPatientHistory('p1', { page: 2, limit: 10 });
      });

      expect(calledUrl()).toBe('http://test/consultations/patient/p1/history?page=2&limit=10');
    });
  });

  // ---- session.getTimeline ------------------------------------------------
  describe('session.getTimeline()', () => {
    it('should GET consultation timeline without scope', async () => {
      const entries = [{ id: 'e1', type: 'context_added', timestamp: '2026-02-19T00:00:00Z' }];
      mockFetch.mockResolvedValueOnce(createMockResponse(entries));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.session.getTimeline();
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/timeline');
      expect(returned).toHaveLength(1);
    });

    it('should append scope query param when provided', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.session.getTimeline('chain');
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/timeline?scope=chain');
    });

    it('should throw when no active consultation', async () => {
      mockStoreData.consultation = null;
      (useAgenticStore as any).mockReturnValue(mockStoreData);

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => { await result.current.session.getTimeline(); }),
      ).rejects.toThrow('No active consultation');
    });
  });
});

// ===========================================================================
// CONTEXT
// ===========================================================================

describe('useArca API — context', () => {
  // ---- context.addCaseNote ------------------------------------------------
  describe('context.addCaseNote()', () => {
    it('should POST with type=case_note and store the item', async () => {
      const item = createMockContextItem({ id: 'cn-1', type: 'case_note' });
      mockFetch.mockResolvedValueOnce(createMockResponse(item));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.context.addCaseNote('Patient has fever');
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/context');
      expect(calledMethod()).toBe('POST');
      expect(calledBody()).toMatchObject({ type: 'CASE_NOTE', content: 'Patient has fever', source: 'USER' });
      expect(mockStoreData.addContextItem).toHaveBeenCalledWith(item);
      expect(returned.id).toBe('cn-1');
    });

    it('should forward metadata as structuredData', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockContextItem()));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.context.addCaseNote('note', { severity: 'high' });
      });

      expect(calledBody()).toMatchObject({ structuredData: { severity: 'high' } });
    });

    it('should toggle context loading flag', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockContextItem()));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.context.addCaseNote('note');
      });

      expect(mockStoreData.setContextLoading).toHaveBeenCalledWith(true);
      expect(mockStoreData.setContextLoading).toHaveBeenCalledWith(false);
    });
  });

  // ---- context.addTranscription -------------------------------------------
  describe('context.addTranscription()', () => {
    it('should POST with type=TRANSCRIPT and source=TRANSCRIPTION', async () => {
      const item = createMockContextItem({ id: 'tx-1', type: 'TRANSCRIPT' });
      mockFetch.mockResolvedValueOnce(createMockResponse(item));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.context.addTranscription('Hello doctor');
      });

      expect(calledBody()).toMatchObject({ type: 'TRANSCRIPT', content: 'Hello doctor', source: 'TRANSCRIPTION' });
      expect(mockStoreData.addContextItem).toHaveBeenCalledWith(item);
      expect(returned.id).toBe('tx-1');
    });
  });

  // ---- context.updateItem -------------------------------------------------
  describe('context.updateItem()', () => {
    it('should PATCH the context item and update store', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(undefined, { status: 204, ok: true } as any));

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.context.updateItem('ctx-42', 'updated content');
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/context/ctx-42');
      expect(calledMethod()).toBe('PATCH');
      expect(calledBody()).toMatchObject({ content: 'updated content' });
      expect(mockStoreData.updateContextItem).toHaveBeenCalledWith('ctx-42', { content: 'updated content' });
    });
  });

  // ---- context.loadSharedContext ------------------------------------------
  describe('context.loadSharedContext()', () => {
    it('should GET shared context and store it', async () => {
      const shared = [createMockContextItem({ id: 's-1' }), createMockContextItem({ id: 's-2' })];
      mockFetch.mockResolvedValueOnce(createMockResponse(shared));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.context.loadSharedContext();
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/context/shared');
      expect(mockStoreData.setSharedContext).toHaveBeenCalledWith(shared);
      expect(returned).toHaveLength(2);
    });
  });

  // ---- context.extractEntities --------------------------------------------
  describe('context.extractEntities()', () => {
    it('should GET all entities when no contextItemId is given', async () => {
      const data = { entities: [{ id: 'e1', entityType: 'DISEASE', text: 'flu' }] };
      mockFetch.mockResolvedValueOnce(createMockResponse(data));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.context.extractEntities();
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/named-entities');
      expect(mockStoreData.setEntities).toHaveBeenCalledWith(data.entities);
      expect(returned).toHaveLength(1);
    });

    it('should GET entities for a specific context item', async () => {
      const data = { entities: [] };
      mockFetch.mockResolvedValueOnce(createMockResponse(data));

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.context.extractEntities('ctx-99');
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/context/ctx-99/named-entities');
    });
  });

  // ---- context.getContextVersions -----------------------------------------
  describe('context.getContextVersions()', () => {
    it('should GET version history for a context item', async () => {
      const versions = [
        { versionNumber: 1, content: 'v1', createdAt: '2026-02-19T00:00:00Z' },
        { versionNumber: 2, content: 'v2', createdAt: '2026-02-19T01:00:00Z' },
      ];
      mockFetch.mockResolvedValueOnce(createMockResponse(versions));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.context.getContextVersions('ctx-55');
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/context/ctx-55/versions');
      expect(returned).toHaveLength(2);
    });
  });

  // ---- context.triggerEntityExtraction ------------------------------------
  describe('context.triggerEntityExtraction()', () => {
    it('should POST to extract-entities endpoint', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(undefined, { status: 204, ok: true } as any));

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.context.triggerEntityExtraction('ctx-77');
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/summary/ctx-77/extract-entities');
      expect(calledMethod()).toBe('POST');
    });
  });

  // ---- context.fetchTranscriptions ----------------------------------------
  describe('context.fetchTranscriptions()', () => {
    it('should GET transcriptions endpoint', async () => {
      const items = [createMockContextItem({ id: 't-1', type: 'transcription' })];
      mockFetch.mockResolvedValueOnce(createMockResponse(items));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.context.fetchTranscriptions();
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/context/transcriptions');
      expect(returned).toHaveLength(1);
    });
  });

  // ---- context.fetchCaseNotes ---------------------------------------------
  describe('context.fetchCaseNotes()', () => {
    it('should GET case-notes endpoint', async () => {
      const items = [createMockContextItem({ id: 'cn-1', type: 'case_note' })];
      mockFetch.mockResolvedValueOnce(createMockResponse(items));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.context.fetchCaseNotes();
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/context/case-notes');
      expect(returned).toHaveLength(1);
    });
  });
});

// ===========================================================================
// SUMMARY
// ===========================================================================

describe('useArca API — summary', () => {
  // ---- summary.generatePreSummary ----------------------------------------
  describe('summary.generatePreSummary()', () => {
    it('should POST to pre-summary endpoint and store result', async () => {
      const summary = createMockSummary({ id: 'ps-1', type: 'pre_summary' });
      mockFetch.mockResolvedValueOnce(createMockResponse(summary));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.summary.generatePreSummary();
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/summary/pre-summary');
      expect(calledMethod()).toBe('POST');
      expect(mockStoreData.addSummary).toHaveBeenCalledWith(summary);
      expect(returned.id).toBe('ps-1');
    });

    it('should pass dnaStyleId option when provided', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockSummary()));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generatePreSummary({ dnaStyleId: 'dna-1' });
      });

      expect(calledBody()).toMatchObject({ dnaStyleId: 'dna-1' });
    });

    it('should toggle summaryGenerating flag', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockSummary()));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generatePreSummary();
      });

      expect(mockStoreData.setSummaryGenerating).toHaveBeenCalledWith(true);
      expect(mockStoreData.setSummaryGenerating).toHaveBeenCalledWith(false);
    });
  });

  // ---- summary.generateSummary -------------------------------------------
  describe('summary.generateSummary()', () => {
    it('should POST to summary endpoint and store result', async () => {
      const summary = createMockSummary({ id: 'sum-1', type: 'summary' });
      mockFetch.mockResolvedValueOnce(createMockResponse(summary));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.summary.generateSummary();
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/summary');
      expect(calledMethod()).toBe('POST');
      expect(mockStoreData.addSummary).toHaveBeenCalledWith(summary);
      expect(returned.id).toBe('sum-1');
    });

    it('should pass options (dnaStyleId, includeNER)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockSummary()));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generateSummary({ dnaStyleId: 'dna-2', includeNER: true });
      });

      expect(calledBody()).toMatchObject({ dnaStyleId: 'dna-2', includeNER: true });
    });
  });

  // ---- summary.updateSummary ---------------------------------------------
  describe('summary.updateSummary()', () => {
    it('should PATCH summary with content and options', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(undefined, { status: 204, ok: true } as any));

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.updateSummary('sum-1', 'New content', { reason: 'edit' } as any);
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/summary/sum-1');
      expect(calledMethod()).toBe('PATCH');
      expect(calledBody()).toMatchObject({ content: 'New content', reason: 'edit' });
    });

    it('should toggle summaryGenerating flag during update', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(undefined, { status: 204, ok: true } as any));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.updateSummary('sum-1', 'edited');
      });

      expect(mockStoreData.setSummaryGenerating).toHaveBeenCalledWith(true);
      expect(mockStoreData.setSummaryGenerating).toHaveBeenCalledWith(false);
    });
  });

  // ---- summary.loadSummaries ---------------------------------------------
  describe('summary.loadSummaries()', () => {
    it('should GET summaries list and store them', async () => {
      const summaries = [createMockSummary({ id: 's1' }), createMockSummary({ id: 's2' })];
      mockFetch.mockResolvedValueOnce(createMockResponse(summaries));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.summary.loadSummaries();
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/summary');
      expect(calledMethod()).toBe('GET');
      expect(mockStoreData.setSummaries).toHaveBeenCalledWith(summaries);
      expect(returned).toHaveLength(2);
    });

    it('should append pagination query params', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.loadSummaries({ page: 1, limit: 5 });
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/summary?page=1&limit=5');
    });
  });

  // ---- summary.getSummaryHistory -----------------------------------------
  describe('summary.getSummaryHistory()', () => {
    it('should GET versions for a summary', async () => {
      const versions = [
        { versionNumber: 1, content: 'v1', createdAt: '2026-02-19T00:00:00Z' },
      ];
      mockFetch.mockResolvedValueOnce(createMockResponse(versions));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.summary.getSummaryHistory('sum-1');
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/summary/sum-1/versions');
      expect(returned).toHaveLength(1);
    });
  });

  // ---- summary.compareSummaryVersions ------------------------------------
  describe('summary.compareSummaryVersions()', () => {
    it('should GET two versions and compute diff', async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse({ content: 'version one text' }))
        .mockResolvedValueOnce(createMockResponse({ content: 'version two text' }));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.summary.compareSummaryVersions('ctx-10', 1, 2);
      });

      expect(calledUrl(0)).toBe('http://test/consultations/cons-1/context/ctx-10/versions/1');
      expect(calledUrl(1)).toBe('http://test/consultations/cons-1/context/ctx-10/versions/2');
      expect(returned).toHaveProperty('changes');
      expect(returned).toHaveProperty('stats');
    });
  });

  // ---- summary.generateSummaryAsync --------------------------------------
  describe('summary.generateSummaryAsync()', () => {
    it('should POST to async endpoint and return job response', async () => {
      const job = { jobId: 'job-1', status: 'queued' };
      mockFetch.mockResolvedValueOnce(createMockResponse(job));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.summary.generateSummaryAsync();
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/summary/async');
      expect(calledMethod()).toBe('POST');
      expect(returned.jobId).toBe('job-1');
    });

    it('should forward options to the async endpoint', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ jobId: 'j-2', status: 'queued' }));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generateSummaryAsync({ dnaStyleId: 'd-1', includeNER: true });
      });

      expect(calledBody()).toMatchObject({ dnaStyleId: 'd-1', includeNER: true });
    });

    it('should toggle summaryGenerating around async call', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ jobId: 'j-3', status: 'queued' }));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generateSummaryAsync();
      });

      expect(mockStoreData.setSummaryGenerating).toHaveBeenCalledWith(true);
      expect(mockStoreData.setSummaryGenerating).toHaveBeenCalledWith(false);
    });
  });

  // ---- summary.generatePreSummaryAsync -----------------------------------
  describe('summary.generatePreSummaryAsync()', () => {
    it('should POST to pre-summary/async endpoint', async () => {
      const job = { jobId: 'psa-1', status: 'queued' };
      mockFetch.mockResolvedValueOnce(createMockResponse(job));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.summary.generatePreSummaryAsync();
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/summary/pre-summary/async');
      expect(calledMethod()).toBe('POST');
      expect(returned.jobId).toBe('psa-1');
    });

    it('should pass dnaStyleId option', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ jobId: 'psa-2', status: 'queued' }));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generatePreSummaryAsync({ dnaStyleId: 'dna-x' });
      });

      expect(calledBody()).toMatchObject({ dnaStyleId: 'dna-x' });
    });
  });

  // ---- summary.generateComprehensiveSummary ------------------------------
  describe('summary.generateComprehensiveSummary()', () => {
    it('should POST to comprehensive endpoint and return result', async () => {
      const compResult = { id: 'comp-1', content: 'Comprehensive text', consultationIds: ['c1', 'c2'] };
      mockFetch.mockResolvedValueOnce(createMockResponse(compResult));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.summary.generateComprehensiveSummary();
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/summary/comprehensive');
      expect(calledMethod()).toBe('POST');
      expect(returned.id).toBe('comp-1');
    });

    it('should forward options to comprehensive endpoint', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ id: 'comp-2' }));
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generateComprehensiveSummary({ dnaStyleId: 'dna-c', includeNER: true });
      });

      expect(calledBody()).toMatchObject({ dnaStyleId: 'dna-c', includeNER: true });
    });
  });

  // ---- summary.getLatestPreSummary ---------------------------------------
  describe('summary.getLatestPreSummary()', () => {
    it('should GET latest pre-summary', async () => {
      const preSummary = createMockSummary({ id: 'lps-1', type: 'pre_summary' });
      mockFetch.mockResolvedValueOnce(createMockResponse(preSummary));

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.summary.getLatestPreSummary();
      });

      expect(calledUrl()).toBe('http://test/consultations/cons-1/summary/pre-summary/latest');
      expect(calledMethod()).toBe('GET');
      expect(returned.id).toBe('lps-1');
    });
  });
});

// ===========================================================================
// withRetry
// ===========================================================================

describe('useArca API — withRetry', () => {
  it('should resolve on first attempt for a successful call', async () => {
    const { result } = renderHook(() => useArca());
    let returned: any;

    await act(async () => {
      returned = await result.current.withRetry(async () => 42);
    });

    expect(returned).toBe(42);
  });

  it('should retry on retriable errors and eventually succeed', async () => {
    const { AgenticError } = await import('../../types/index.js');
    let callCount = 0;

    const fn = async () => {
      callCount++;
      if (callCount < 3) throw new AgenticError('NETWORK_ERROR', 'timeout');
      return 'success';
    };

    const { result } = renderHook(() => useArca());
    let returned: any;

    await act(async () => {
      returned = await result.current.withRetry(fn, { maxRetries: 3, delayMs: 0 });
    });

    expect(returned).toBe('success');
    expect(callCount).toBe(3);
  });

  it('should throw immediately for non-retriable errors', async () => {
    const { AgenticError } = await import('../../types/index.js');

    const fn = async () => {
      throw new AgenticError('AUTHENTICATION_ERROR', 'unauthorized');
    };

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => {
        await result.current.withRetry(fn, { maxRetries: 3, delayMs: 0 });
      }),
    ).rejects.toThrow('unauthorized');
  });
});

// ===========================================================================
// Guard — methods requiring active consultation
// ===========================================================================

describe('useArca API — consultation guard', () => {
  beforeEach(() => {
    mockStoreData.consultation = null;
    (useAgenticStore as any).mockReturnValue(mockStoreData);
  });

  it('context.addCaseNote throws without consultation', async () => {
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => { await result.current.context.addCaseNote('x'); }),
    ).rejects.toThrow('No active consultation');
  });

  it('context.addTranscription throws without consultation', async () => {
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => { await result.current.context.addTranscription('x'); }),
    ).rejects.toThrow('No active consultation');
  });

  it('context.updateItem throws without consultation', async () => {
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => { await result.current.context.updateItem('id', 'c'); }),
    ).rejects.toThrow('No active consultation');
  });

  it('context.loadSharedContext throws without consultation', async () => {
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => { await result.current.context.loadSharedContext(); }),
    ).rejects.toThrow('No active consultation');
  });

  it('context.extractEntities throws without consultation', async () => {
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => { await result.current.context.extractEntities(); }),
    ).rejects.toThrow('No active consultation');
  });

  it('context.fetchTranscriptions throws without consultation', async () => {
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => { await result.current.context.fetchTranscriptions(); }),
    ).rejects.toThrow('No active consultation');
  });

  it('context.fetchCaseNotes throws without consultation', async () => {
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => { await result.current.context.fetchCaseNotes(); }),
    ).rejects.toThrow('No active consultation');
  });

  it('summary.generateSummary throws without consultation', async () => {
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => { await result.current.summary.generateSummary(); }),
    ).rejects.toThrow('No active consultation');
  });

  it('summary.generatePreSummary throws without consultation', async () => {
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => { await result.current.summary.generatePreSummary(); }),
    ).rejects.toThrow('No active consultation');
  });

  it('summary.loadSummaries throws without consultation', async () => {
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => { await result.current.summary.loadSummaries(); }),
    ).rejects.toThrow('No active consultation');
  });
});
