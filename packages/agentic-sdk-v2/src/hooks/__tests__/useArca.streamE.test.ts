/**
 * @arcaai/vox - useArca Stream E Hook Tests (Layer 2 — Feature Parity)
 *
 * Tests for new hook methods and behaviors added by Stream E:
 * - SUM-01: generateSummaryAsync, generatePreSummaryAsync
 * - SUM-02: generateComprehensiveSummary
 * - SUM-03: getLatestPreSummary
 * - SUM-04: Summaries fetched on consultation open/load
 * - SES-04: getTimeline
 * - SES-05: getContextVersions
 * - SES-06: Pagination params passed through to API calls
 * - NER-R-03: triggerEntityExtraction (using SUMMARY_ENDPOINTS.EXTRACT_ENTITIES)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// =============================================================================
// Mock setup
// =============================================================================

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
};

const mockLogger = {
  child: vi.fn(() => ({
    startOperation: vi.fn(() => ({
      end: vi.fn(),
      error: vi.fn(),
    })),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
};

const mockStore = {
  consultation: null as { id: string; patientId: string; doctorId: string; appointmentDate: string; createdAt: string; updatedAt: string; contextItems?: unknown[] } | null,
  relatedConsultations: [],
  sessionLoading: false,
  sessionError: null,
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
  audioError: null,
  contextItems: [],
  entities: [],
  sharedContext: [],
  contextLoading: false,
  contextError: null,
  summaries: [] as Array<{ id: string; contextItemId: string; content: string; type: string; llmProvider: string; modelName: string; createdAt: string }>,
  dnaStyle: null,
  summaryGenerating: false,
  summaryError: null,
  initialized: true,
  globalError: null,
  apiClient: mockApiClient,
  pluginManager: null,
  logger: mockLogger,
  setSessionLoading: vi.fn(),
  setSessionError: vi.fn(),
  setConsultation: vi.fn(),
  clearContext: vi.fn(),
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
  addContextItem: vi.fn(),
  updateContextItem: vi.fn(),
  setSharedContext: vi.fn(),
  setEntities: vi.fn(),
  addEntities: vi.fn(),
  setSummaryGenerating: vi.fn(),
  setSummaryError: vi.fn(),
  addSummary: vi.fn(),
  setSummaries: vi.fn(),
  setDNAStyle: vi.fn(),
  reset: vi.fn(),
};

vi.mock('../../store', () => ({
  useAgenticStore: vi.fn(() => mockStore),
  selectTranscriptions: vi.fn(() => []),
  selectCaseNotes: vi.fn(() => []),
  selectIsAudioSource: vi.fn(() => false),
  selectTranscriptionPipelineState: vi.fn(() => null),
  selectKnowledgePipelineState: vi.fn(() => null),
}));

import { useArca } from '../useArca';
import { SUMMARY_ENDPOINTS, CONSULTATION_ENDPOINTS, CONTEXT_ENDPOINTS } from '../../core/constants';

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.consultation = {
    id: 'consult-1',
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: '2026-02-17',
    createdAt: '2026-02-17T00:00:00Z',
    updatedAt: '2026-02-17T00:00:00Z',
  };
  mockStore.summaries = [];
});

// =============================================================================
// SUM-01: Async summary generation
// =============================================================================

describe('SUM-01: async summary generation', () => {
  it('should expose generateSummaryAsync on summary interface', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.generateSummaryAsync).toBe('function');
  });

  it('should expose generatePreSummaryAsync on summary interface', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.generatePreSummaryAsync).toBe('function');
  });

  it('should call GENERATE_ASYNC endpoint with empty object when no options', async () => {
    const jobResponse = {
      jobId: 'job-1',
      status: 'pending',
      consultationId: 'consult-1',
      createdAt: '2026-02-17T00:00:00Z',
    };
    mockApiClient.post.mockResolvedValueOnce(jobResponse);

    const { result } = renderHook(() => useArca());
    let response: unknown;
    await act(async () => {
      response = await result.current.summary.generateSummaryAsync();
    });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.GENERATE_ASYNC('consult-1'),
      {}
    );
    expect(response).toEqual(jobResponse);
  });

  it('should forward options (dnaStyleId, includeNER) to GENERATE_ASYNC endpoint', async () => {
    const jobResponse = {
      jobId: 'job-opts',
      status: 'pending',
      consultationId: 'consult-1',
      createdAt: '2026-02-17T00:00:00Z',
    };
    mockApiClient.post.mockResolvedValueOnce(jobResponse);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.summary.generateSummaryAsync({
        dnaStyleId: 'dna-42',
        includeNER: true,
      });
    });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.GENERATE_ASYNC('consult-1'),
      { dnaStyleId: 'dna-42', includeNER: true }
    );
  });

  it('should call PRE_SUMMARY_ASYNC endpoint with empty object when no options', async () => {
    const jobResponse = {
      jobId: 'job-2',
      status: 'pending',
      consultationId: 'consult-1',
      createdAt: '2026-02-17T00:00:00Z',
    };
    mockApiClient.post.mockResolvedValueOnce(jobResponse);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.summary.generatePreSummaryAsync();
    });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC('consult-1'),
      {}
    );
  });

  it('should forward options (dnaStyleId) to PRE_SUMMARY_ASYNC endpoint', async () => {
    const jobResponse = {
      jobId: 'job-pre-opts',
      status: 'pending',
      consultationId: 'consult-1',
      createdAt: '2026-02-17T00:00:00Z',
    };
    mockApiClient.post.mockResolvedValueOnce(jobResponse);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.summary.generatePreSummaryAsync({ dnaStyleId: 'dna-99' });
    });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC('consult-1'),
      { dnaStyleId: 'dna-99' }
    );
  });

  it('should throw when no active consultation (generateSummaryAsync)', async () => {
    mockStore.consultation = null;
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.summary.generateSummaryAsync();
      })
    ).rejects.toThrow('No active consultation');
  });

  it('should throw when no active consultation (generatePreSummaryAsync)', async () => {
    mockStore.consultation = null;
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.summary.generatePreSummaryAsync();
      })
    ).rejects.toThrow('No active consultation');
  });

  it('should set summaryGenerating true then false on generateSummaryAsync', async () => {
    mockApiClient.post.mockResolvedValueOnce({
      jobId: 'j-1', status: 'pending', consultationId: 'consult-1', createdAt: '2026-02-17T00:00:00Z',
    });
    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.summary.generateSummaryAsync();
    });

    expect(mockStore.setSummaryGenerating).toHaveBeenCalledWith(true);
    expect(mockStore.setSummaryGenerating).toHaveBeenCalledWith(false);
    expect(mockStore.setSummaryError).toHaveBeenCalledWith(null);
  });

  it('should set summaryError on generateSummaryAsync failure', async () => {
    const apiError = new Error('Network error');
    mockApiClient.post.mockRejectedValueOnce(apiError);

    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.summary.generateSummaryAsync();
      })
    ).rejects.toThrow('Network error');

    expect(mockStore.setSummaryError).toHaveBeenCalledWith(apiError);
    expect(mockStore.setSummaryGenerating).toHaveBeenCalledWith(false);
  });

  it('should set summaryError on generatePreSummaryAsync failure', async () => {
    const apiError = new Error('Server error');
    mockApiClient.post.mockRejectedValueOnce(apiError);

    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.summary.generatePreSummaryAsync();
      })
    ).rejects.toThrow('Server error');

    expect(mockStore.setSummaryError).toHaveBeenCalledWith(apiError);
    expect(mockStore.setSummaryGenerating).toHaveBeenCalledWith(false);
  });
});

// =============================================================================
// SUM-02: Comprehensive summary
// =============================================================================

describe('SUM-02: comprehensive summary', () => {
  it('should expose generateComprehensiveSummary on summary interface', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.generateComprehensiveSummary).toBe('function');
  });

  it('should call COMPREHENSIVE endpoint with empty object when no options', async () => {
    const response = {
      id: 'cs-1',
      content: 'Comprehensive summary',
      consultationIds: ['consult-1'],
      createdAt: '2026-02-17T00:00:00Z',
    };
    mockApiClient.post.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useArca());
    let res: unknown;
    await act(async () => {
      res = await result.current.summary.generateComprehensiveSummary();
    });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.COMPREHENSIVE('consult-1'),
      {}
    );
    expect(res).toEqual(response);
  });

  it('should forward options to COMPREHENSIVE endpoint', async () => {
    const response = {
      id: 'cs-2',
      content: 'Comprehensive summary with NER',
      consultationIds: ['consult-1'],
      createdAt: '2026-02-17T00:00:00Z',
    };
    mockApiClient.post.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.summary.generateComprehensiveSummary({
        dnaStyleId: 'dna-7',
        includeNER: true,
      });
    });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.COMPREHENSIVE('consult-1'),
      { dnaStyleId: 'dna-7', includeNER: true }
    );
  });

  it('should throw when no active consultation', async () => {
    mockStore.consultation = null;
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.summary.generateComprehensiveSummary();
      })
    ).rejects.toThrow('No active consultation');
  });

  it('should set summaryError on API failure', async () => {
    const apiError = new Error('Comprehensive failed');
    mockApiClient.post.mockRejectedValueOnce(apiError);

    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.summary.generateComprehensiveSummary();
      })
    ).rejects.toThrow('Comprehensive failed');

    expect(mockStore.setSummaryError).toHaveBeenCalledWith(apiError);
    expect(mockStore.setSummaryGenerating).toHaveBeenCalledWith(false);
  });
});

// =============================================================================
// SUM-03: Get latest pre-summary
// =============================================================================

describe('SUM-03: getLatestPreSummary', () => {
  it('should expose getLatestPreSummary on summary interface', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.getLatestPreSummary).toBe('function');
  });

  it('should call LATEST_PRE_SUMMARY endpoint', async () => {
    const preSummary = {
      id: 'ps-1',
      contextItemId: 'ctx-1',
      content: 'Pre-summary content',
      type: 'pre_summary',
      llmProvider: 'openai',
      modelName: 'gpt-4',
      createdAt: '2026-02-17T00:00:00Z',
    };
    mockApiClient.get.mockResolvedValueOnce(preSummary);

    const { result } = renderHook(() => useArca());
    let res: unknown;
    await act(async () => {
      res = await result.current.summary.getLatestPreSummary();
    });

    expect(mockApiClient.get).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY('consult-1')
    );
    expect(res).toEqual(preSummary);
  });

  it('should throw when no active consultation', async () => {
    mockStore.consultation = null;
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.summary.getLatestPreSummary();
      })
    ).rejects.toThrow('No active consultation');
  });

  it('should propagate API errors', async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error('Not found'));

    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.summary.getLatestPreSummary();
      })
    ).rejects.toThrow('Not found');
  });
});

// =============================================================================
// SUM-04: Fetch summaries on consultation open/load
// =============================================================================

describe('SUM-04: load summaries on consultation open', () => {
  it('should expose loadSummaries on summary interface', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.loadSummaries).toBe('function');
  });

  it('should call LIST endpoint and populate store', async () => {
    const summaries = [
      { id: 's-1', contextItemId: 'ctx-1', content: 'Summary 1', type: 'summary', llmProvider: 'openai', modelName: 'gpt-4', createdAt: '2026-02-17' },
      { id: 's-2', contextItemId: 'ctx-2', content: 'Pre-summary', type: 'pre_summary', llmProvider: 'openai', modelName: 'gpt-4', createdAt: '2026-02-17' },
    ];
    mockApiClient.get.mockResolvedValueOnce(summaries);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.summary.loadSummaries();
    });

    expect(mockApiClient.get).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.LIST('consult-1')
    );
    expect(mockStore.setSummaries).toHaveBeenCalledWith(summaries);
  });

  it('should not append query string when no pagination provided', async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.summary.loadSummaries();
    });

    const calledUrl = mockApiClient.get.mock.calls[0][0];
    expect(calledUrl).toBe(SUMMARY_ENDPOINTS.LIST('consult-1'));
    expect(calledUrl).not.toContain('?');
  });

  it('should throw when no active consultation', async () => {
    mockStore.consultation = null;
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.summary.loadSummaries();
      })
    ).rejects.toThrow('No active consultation');
  });

  it('should propagate API errors', async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error('Fetch failed'));

    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.summary.loadSummaries();
      })
    ).rejects.toThrow('Fetch failed');
  });

  it('should populate store with empty array when API returns empty', async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.summary.loadSummaries();
    });

    expect(mockStore.setSummaries).toHaveBeenCalledWith([]);
  });
});

// =============================================================================
// SES-04: Timeline
// =============================================================================

describe('SES-04: getTimeline', () => {
  it('should expose getTimeline on session interface', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.session.getTimeline).toBe('function');
  });

  it('should call TIMELINE endpoint without scope query when no scope given', async () => {
    const timeline = [
      { id: 't-1', consultationId: 'consult-1', type: 'opened', timestamp: '2026-02-17T10:00:00Z', description: 'Consultation opened' },
    ];
    mockApiClient.get.mockResolvedValueOnce(timeline);

    const { result } = renderHook(() => useArca());
    let res: unknown;
    await act(async () => {
      res = await result.current.session.getTimeline();
    });

    const calledUrl = mockApiClient.get.mock.calls[0][0];
    expect(calledUrl).toBe(CONSULTATION_ENDPOINTS.TIMELINE('consult-1'));
    expect(calledUrl).not.toContain('?');
    expect(res).toEqual(timeline);
  });

  it('should pass scope=chain query parameter', async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.session.getTimeline('chain');
    });

    expect(mockApiClient.get).toHaveBeenCalledWith(
      CONSULTATION_ENDPOINTS.TIMELINE('consult-1') + '?scope=chain'
    );
  });

  it('should pass scope=single query parameter', async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.session.getTimeline('single');
    });

    expect(mockApiClient.get).toHaveBeenCalledWith(
      CONSULTATION_ENDPOINTS.TIMELINE('consult-1') + '?scope=single'
    );
  });

  it('should throw when no active consultation', async () => {
    mockStore.consultation = null;
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.session.getTimeline();
      })
    ).rejects.toThrow('No active consultation');
  });

  it('should propagate API errors', async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error('Timeline failed'));

    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.session.getTimeline();
      })
    ).rejects.toThrow('Timeline failed');
  });
});

// =============================================================================
// SES-05: Context version history
// =============================================================================

describe('SES-05: getContextVersions', () => {
  it('should expose getContextVersions on context interface', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.context.getContextVersions).toBe('function');
  });

  it('should call VERSIONS endpoint', async () => {
    const versions = [
      { versionNumber: 1, content: 'Original', updatedAt: '2026-02-17T10:00:00Z', updatedBy: 'doctor-1' },
      { versionNumber: 2, content: 'Updated', updatedAt: '2026-02-17T11:00:00Z', updatedBy: 'doctor-1' },
    ];
    mockApiClient.get.mockResolvedValueOnce(versions);

    const { result } = renderHook(() => useArca());
    let res: unknown;
    await act(async () => {
      res = await result.current.context.getContextVersions('ctx-1');
    });

    expect(mockApiClient.get).toHaveBeenCalledWith(
      CONTEXT_ENDPOINTS.VERSIONS('consult-1', 'ctx-1')
    );
    expect(res).toEqual(versions);
  });

  it('should throw when no active consultation', async () => {
    mockStore.consultation = null;
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.context.getContextVersions('ctx-1');
      })
    ).rejects.toThrow('No active consultation');
  });

  it('should propagate API errors', async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error('Versions unavailable'));

    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.context.getContextVersions('ctx-1');
      })
    ).rejects.toThrow('Versions unavailable');
  });

  it('should handle empty version list', async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useArca());
    let res: unknown;
    await act(async () => {
      res = await result.current.context.getContextVersions('ctx-new');
    });

    expect(res).toEqual([]);
  });
});

// =============================================================================
// SES-06: Pagination — verify source code uses PaginationParams
// =============================================================================

describe('SES-06: pagination support in hook methods', () => {
  it('should not append query string to getPatientHistory when no pagination', async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.session.getPatientHistory('patient-1');
    });

    const calledUrl = mockApiClient.get.mock.calls[0][0];
    expect(calledUrl).toBe('/consultations/patient/patient-1/history');
    expect(calledUrl).not.toContain('?');
  });

  it('should accept both page and limit in getPatientHistory', async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.session.getPatientHistory('patient-1', { page: 2, limit: 10 });
    });

    const calledUrl = mockApiClient.get.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/consultations/patient/patient-1/history');
    expect(calledUrl).toContain('page=2');
    expect(calledUrl).toContain('limit=10');
  });

  it('should accept only page without limit in getPatientHistory', async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.session.getPatientHistory('patient-1', { page: 3 });
    });

    const calledUrl = mockApiClient.get.mock.calls[0][0] as string;
    expect(calledUrl).toContain('page=3');
    expect(calledUrl).not.toContain('limit=');
  });

  it('should accept only limit without page in getPatientHistory', async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.session.getPatientHistory('patient-1', { limit: 25 });
    });

    const calledUrl = mockApiClient.get.mock.calls[0][0] as string;
    expect(calledUrl).toContain('limit=25');
    expect(calledUrl).not.toContain('page=');
  });

  it('should accept pagination params in loadSummaries', async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.summary.loadSummaries({ page: 1, limit: 5 });
    });

    const calledUrl = mockApiClient.get.mock.calls[0][0] as string;
    expect(calledUrl).toContain('page=1');
    expect(calledUrl).toContain('limit=5');
  });

  it('should accept only page without limit in loadSummaries', async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.summary.loadSummaries({ page: 4 });
    });

    const calledUrl = mockApiClient.get.mock.calls[0][0] as string;
    expect(calledUrl).toContain('page=4');
    expect(calledUrl).not.toContain('limit=');
  });
});

// =============================================================================
// NER-R-03: triggerEntityExtraction (wire EXTRACT_ENTITIES)
// =============================================================================

describe('NER-R-03: triggerEntityExtraction', () => {
  it('should expose triggerEntityExtraction on context interface', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.context.triggerEntityExtraction).toBe('function');
  });

  it('should call EXTRACT_ENTITIES endpoint with empty body', async () => {
    mockApiClient.post.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useArca());
    await act(async () => {
      await result.current.context.triggerEntityExtraction('ctx-1');
    });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.EXTRACT_ENTITIES('consult-1', 'ctx-1'),
      {}
    );
  });

  it('should throw without consultation', async () => {
    mockStore.consultation = null;
    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.context.triggerEntityExtraction('ctx-1');
      })
    ).rejects.toThrow('No active consultation');
  });

  it('should propagate API errors', async () => {
    mockApiClient.post.mockRejectedValueOnce(new Error('Extraction failed'));

    const { result } = renderHook(() => useArca());
    await expect(
      act(async () => {
        await result.current.context.triggerEntityExtraction('ctx-1');
      })
    ).rejects.toThrow('Extraction failed');
  });
});
