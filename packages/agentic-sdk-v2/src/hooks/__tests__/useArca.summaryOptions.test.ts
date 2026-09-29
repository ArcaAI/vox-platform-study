/**
 * useArca Summary Generation Options Tests
 *
 * Tests that generateSummary, generatePreSummary, generateSummaryAsync,
 * and generatePreSummaryAsync accept and pass through the new parameters:
 * transcript, promptTemplateId, departmentId.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArca } from '../useArca';
import { SUMMARY_ENDPOINTS, CONSULTATION_JOB_ENDPOINTS } from '../../core/constants';

const mockStoreDefaults = {
  consultation: null as Record<string, unknown> | null,
  relatedConsultations: [],
  sessionLoading: false,
  sessionError: null,
  isCapturing: false,
  isMuted: false,
  audioLevel: 0,
  isSpeaking: false,
  currentTranscript: '',
  audioPlugins: {
    noiseFilter: { isActive: false, isSupported: false },
    vad: { isActive: false, isSupported: false },
    stt: { isActive: false, isSupported: false, isProcessing: false },
  },
  audioError: null,
  contextItems: [],
  entities: [],
  sharedContext: [],
  contextLoading: false,
  contextError: null,
  summaries: [],
  dnaStyle: null,
  summaryGenerating: false,
  summaryError: null,
  initialized: true,
  globalError: null,
  apiClient: null as Record<string, unknown> | null,
  pluginManager: null as Record<string, unknown> | null,
  logger: null,
  transcriptSegments: [],
  audioLanguage: 'en',
  setSessionLoading: vi.fn(),
  setSessionError: vi.fn(),
  setConsultation: vi.fn(),
  clearContext: vi.fn(),
  addContextItem: vi.fn(),
  setRelatedConsultations: vi.fn(),
  setIsCapturing: vi.fn(),
  setIsMuted: vi.fn(),
  setAudioLevel: vi.fn(),
  setIsSpeaking: vi.fn(),
  setCurrentTranscript: vi.fn(),
  setAudioPlugins: vi.fn(),
  setAudioError: vi.fn(),
  setContextLoading: vi.fn(),
  setContextError: vi.fn(),
  updateContextItem: vi.fn(),
  setSharedContext: vi.fn(),
  setEntities: vi.fn(),
  addEntities: vi.fn(),
  setSummaryGenerating: vi.fn(),
  setSummaryError: vi.fn(),
  addSummary: vi.fn(),
  setSummaries: vi.fn(),
  setDNAStyle: vi.fn(),
  setTranscriptSegments: vi.fn(),
  setAudioLanguage: vi.fn(),
  reset: vi.fn(),
};

let currentMockStore = { ...mockStoreDefaults };

vi.mock('../../store', () => {
  return {
    useAgenticStore: vi.fn(() => currentMockStore),
    selectTranscriptions: vi.fn(() => []),
    selectCaseNotes: vi.fn(() => []),
    selectIsAudioSource: vi.fn(() => false),
    selectTranscriptionPipelineState: vi.fn(() => null),
    selectKnowledgePipelineState: vi.fn(() => null),
  };
});

describe('B-1: Summary generation with extended options', () => {
  const mockPost = vi.fn();
  const mockGet = vi.fn();
  const mockPatch = vi.fn();
  const consultationObj = { id: 'c-001', patientId: 'p-123', doctorId: 'd-456', appointmentDate: '2026-02-17', createdAt: '', updatedAt: '' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockReset();
    mockGet.mockReset();
    mockPatch.mockReset();
    currentMockStore = {
      ...mockStoreDefaults,
      apiClient: { get: mockGet, post: mockPost, patch: mockPatch, delete: vi.fn() },
      consultation: consultationObj,
      setSummaryGenerating: vi.fn(),
      setSummaryError: vi.fn(),
      addSummary: vi.fn(),
      setSummaries: vi.fn(),
    };
  });

  // TASK-1012 (L-2): `generateSummary` / `generatePreSummary` run on the ASYNC plane (the
  // synchronous routes are gone), and every generate path maps the deprecated option names
  // onto the gateway DTO fields — `GenerateSummaryRequest` rejects unknown keys, so the
  // pass-through this hook used to do was a 400 for `transcript`/`promptTemplateId`/`departmentId`.
  const jobResp = { jobId: 'job-1', status: 'pending', consultationId: 'c-001', createdAt: '' };
  const summaryResp = {
    id: 's-1',
    contextItemId: 'ctx-1',
    content: 'Summary',
    type: 'summary',
    llmProvider: 'openai',
    modelName: 'gpt-4',
    createdAt: '',
  };
  const preSummaryResp = { ...summaryResp, id: 'ps-1', content: 'Pre-summary', type: 'pre_summary' };

  beforeEach(() => {
    mockPost.mockResolvedValue(jobResp);
    mockGet.mockImplementation(async (url: string) => {
      if (url === CONSULTATION_JOB_ENDPOINTS.GET('job-1')) return { jobId: 'job-1', status: 'COMPLETED', progress: 100 };
      if (url === SUMMARY_ENDPOINTS.LATEST('c-001')) return summaryResp;
      if (url === SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY('c-001')) return preSummaryResp;
      throw new Error(`unexpected GET ${url}`);
    });
  });

  describe('generateSummary with new params', () => {
    it('maps `transcript` → `transcription` in the async request body', async () => {
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generateSummary({
          transcript: 'Doctor: Hello patient. Patient: I have a headache.',
        });
      });

      expect(mockPost).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'), {
        transcription: 'Doctor: Hello patient. Patient: I have a headache.',
      });
    });

    it('maps `promptTemplateId` → `template`', async () => {
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generateSummary({
          promptTemplateId: 'pt-neurology-001',
        });
      });

      expect(mockPost).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'), { template: 'pt-neurology-001' });
    });

    it('tucks `departmentId` under `options.departmentId`', async () => {
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generateSummary({
          departmentId: 'dept-cardiology',
        });
      });

      expect(mockPost).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'), { options: { departmentId: 'dept-cardiology' } });
    });

    it('passes all params together, mapped, and resolves the persisted summary', async () => {
      const { result } = renderHook(() => useArca());

      let resolved: unknown;
      await act(async () => {
        resolved = await result.current.summary.generateSummary({
          dnaStyleId: 'dna-1',
          includeNER: true,
          transcript: 'Transcript text',
          promptTemplateId: 'pt-1',
          departmentId: 'dept-1',
        });
      });

      expect(mockPost).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'), {
        dnaStyleId: 'dna-1',
        includeNER: true,
        transcription: 'Transcript text',
        template: 'pt-1',
        options: { departmentId: 'dept-1' },
      });
      expect(resolved).toEqual(summaryResp);
    });
  });

  describe('generatePreSummary with new params', () => {
    it('posts the mapped body to the pre-summary ASYNC route and resolves the pre-summary', async () => {
      const { result } = renderHook(() => useArca());

      let resolved: unknown;
      await act(async () => {
        resolved = await result.current.summary.generatePreSummary({
          dnaStyleId: 'dna-1',
          transcript: 'Some transcript',
          promptTemplateId: 'pt-1',
          departmentId: 'dept-1',
        });
      });

      expect(mockPost).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC('c-001'), {
        dnaStyleId: 'dna-1',
        transcription: 'Some transcript',
        template: 'pt-1',
        options: { departmentId: 'dept-1' },
      });
      expect(resolved).toEqual(preSummaryResp);
    });
  });

  describe('generateSummaryAsync with new params', () => {
    it('maps transcript, promptTemplateId, departmentId in the request body', async () => {
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generateSummaryAsync({
          dnaStyleId: 'dna-1',
          includeNER: true,
          transcript: 'Async transcript',
          promptTemplateId: 'pt-async',
          departmentId: 'dept-async',
        });
      });

      expect(mockPost).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'), {
        dnaStyleId: 'dna-1',
        includeNER: true,
        transcription: 'Async transcript',
        template: 'pt-async',
        options: { departmentId: 'dept-async' },
      });
    });
  });

  describe('generatePreSummaryAsync with new params', () => {
    it('maps transcript, promptTemplateId, departmentId in the request body', async () => {
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generatePreSummaryAsync({
          dnaStyleId: 'dna-2',
          transcript: 'Pre-async transcript',
          promptTemplateId: 'pt-pre-async',
          departmentId: 'dept-pre-async',
        });
      });

      expect(mockPost).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC('c-001'), {
        dnaStyleId: 'dna-2',
        transcription: 'Pre-async transcript',
        template: 'pt-pre-async',
        options: { departmentId: 'dept-pre-async' },
      });
    });
  });

  describe('backwards compatibility', () => {
    it('generateSummary still works with only dnaStyleId and includeNER', async () => {
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generateSummary({ dnaStyleId: 'dna-1', includeNER: true });
      });

      expect(mockPost).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'), { dnaStyleId: 'dna-1', includeNER: true });
    });

    it('generateSummary still works with no options (empty body)', async () => {
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.generateSummary();
      });

      expect(mockPost).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'), {});
    });
  });
});

// =============================================================================
// Type-level verification: UseArcaSummary interface exposes new option types
// =============================================================================

describe('B-1: UseArcaSummary interface type contracts', () => {
  it('UseArcaSummary.generateSummary type should accept SummaryGenerationOptions', () => {
    const { result } = renderHook(() => useArca());
    const fn = result.current.summary.generateSummary;
    type Params = Parameters<typeof fn>;
    type Options = NonNullable<Params[0]>;

    const opts: Options = {
      dnaStyleId: 'dna-1',
      includeNER: true,
      transcript: 'text',
      promptTemplateId: 'pt-1',
      departmentId: 'dept-1',
    };
    expect(opts.transcript).toBe('text');
    expect(opts.promptTemplateId).toBe('pt-1');
    expect(opts.departmentId).toBe('dept-1');
  });

  it('UseArcaSummary.generatePreSummary type should accept extended options', () => {
    const { result } = renderHook(() => useArca());
    const fn = result.current.summary.generatePreSummary;
    type Params = Parameters<typeof fn>;
    type Options = NonNullable<Params[0]>;

    const opts: Options = {
      dnaStyleId: 'dna-1',
      transcript: 'text',
      promptTemplateId: 'pt-1',
      departmentId: 'dept-1',
    };
    expect(opts.transcript).toBe('text');
  });

  it('UseArcaSummary.generateSummaryAsync type should accept extended options', () => {
    const { result } = renderHook(() => useArca());
    const fn = result.current.summary.generateSummaryAsync;
    type Params = Parameters<typeof fn>;
    type Options = NonNullable<Params[0]>;

    const opts: Options = {
      dnaStyleId: 'dna-1',
      includeNER: true,
      transcript: 'text',
      promptTemplateId: 'pt-1',
      departmentId: 'dept-1',
    };
    expect(opts.transcript).toBe('text');
  });

  it('UseArcaSummary.generatePreSummaryAsync type should accept extended options', () => {
    const { result } = renderHook(() => useArca());
    const fn = result.current.summary.generatePreSummaryAsync;
    type Params = Parameters<typeof fn>;
    type Options = NonNullable<Params[0]>;

    const opts: Options = {
      dnaStyleId: 'dna-1',
      transcript: 'text',
      promptTemplateId: 'pt-1',
      departmentId: 'dept-1',
    };
    expect(opts.transcript).toBe('text');
  });
});
