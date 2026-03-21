/**
 * @arcaai/vox - useArca Session Alignment Tests (SES-01 + HOOK-01)
 *
 * SES-01: useArca must use real CONSULTATION_ENDPOINTS (OPEN, GET, etc.)
 *         and NOT reference undefined constants (CREATE, REVISIT, CHAIN, etc.)
 * HOOK-01: useArca.session must expose the open() get-or-create model,
 *         NOT the old lifecycle (create/startRevisit/end/pause/resume).
 *
 * These tests verify RUNTIME BEHAVIOR, not source-code strings.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArca } from '../useArca';
import {
  CONSULTATION_ENDPOINTS,
  CONTEXT_ENDPOINTS,
} from '../../core/constants';

// =============================================================================
// Store mock (follows the pattern from useArca.dx.test.ts)
// =============================================================================

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
    vad: { isActive: true, isSupported: true },
    stt: { isActive: true, isSupported: true, isProcessing: false },
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

// =============================================================================
// SES-01: Verify endpoint constants exist at the right paths
// =============================================================================

describe('SES-01: endpoint constants existence', () => {
  it('should have OPEN endpoint (get-or-create)', () => {
    expect(CONSULTATION_ENDPOINTS.OPEN).toBe('/consultations/open');
  });

  it('should have GET endpoint as a function', () => {
    expect(typeof CONSULTATION_ENDPOINTS.GET).toBe('function');
    expect(CONSULTATION_ENDPOINTS.GET('abc')).toBe('/consultations/abc');
  });

  it('should have PATIENT_HISTORY endpoint as a function', () => {
    expect(typeof CONSULTATION_ENDPOINTS.PATIENT_HISTORY).toBe('function');
    expect(CONSULTATION_ENDPOINTS.PATIENT_HISTORY('p1')).toBe(
      '/consultations/patient/p1/history'
    );
  });

  it('should have PATIENT_DATE endpoint as a function', () => {
    expect(typeof CONSULTATION_ENDPOINTS.PATIENT_DATE).toBe('function');
    expect(CONSULTATION_ENDPOINTS.PATIENT_DATE('p1', '2026-02-17')).toBe(
      '/consultations/patient/p1/date/2026-02-17'
    );
  });

  it('should have TIMELINE endpoint (SES-04)', () => {
    expect(typeof CONSULTATION_ENDPOINTS.TIMELINE).toBe('function');
    expect(CONSULTATION_ENDPOINTS.TIMELINE('c1')).toBe('/consultations/c1/timeline');
  });

  it('should NOT have deprecated CREATE, REVISIT, END, PAUSE, RESUME, BY_PATIENT_DATE', () => {
    const endpoints = CONSULTATION_ENDPOINTS as Record<string, unknown>;
    expect(endpoints.CREATE).toBeUndefined();
    expect(endpoints.REVISIT).toBeUndefined();
    expect(endpoints.END).toBeUndefined();
    expect(endpoints.PAUSE).toBeUndefined();
    expect(endpoints.RESUME).toBeUndefined();
    expect(endpoints.BY_PATIENT_DATE).toBeUndefined();
  });

  it('should have CONTEXT_ENDPOINTS.UPDATE (SES-03 — fixed in Layer 0)', () => {
    expect(typeof CONTEXT_ENDPOINTS.UPDATE).toBe('function');
    expect(CONTEXT_ENDPOINTS.UPDATE('c1', 'ctx1')).toBe(
      '/consultations/c1/context/ctx1'
    );
  });
});

// =============================================================================
// HOOK-01: Verify useArca.session interface at runtime
// =============================================================================

describe('HOOK-01: useArca.session interface shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMockStore = {
      ...mockStoreDefaults,
      setSessionLoading: vi.fn(),
      setSessionError: vi.fn(),
      setConsultation: vi.fn(),
      clearContext: vi.fn(),
      addContextItem: vi.fn(),
    };
  });

  it('should expose open() as a function on session', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.session.open).toBe('function');
  });

  it('should expose load() as a function on session', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.session.load).toBe('function');
  });

  it('should expose findByPatientDate() as a function on session', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.session.findByPatientDate).toBe('function');
  });

  it('should expose getPatientHistory() as a function on session', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.session.getPatientHistory).toBe('function');
  });

  it('should expose getTimeline() as a function on session (SES-04)', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.session.getTimeline).toBe('function');
  });

  it('should NOT expose old lifecycle methods (create, startRevisit, end, pause, resume)', () => {
    const { result } = renderHook(() => useArca());
    const session = result.current.session as Record<string, unknown>;
    expect(session.create).toBeUndefined();
    expect(session.startRevisit).toBeUndefined();
    expect(session.end).toBeUndefined();
    expect(session.pause).toBeUndefined();
    expect(session.resume).toBeUndefined();
  });

  it('should expose consultation, relatedConsultations, isLoading, error state', () => {
    const { result } = renderHook(() => useArca());
    expect(result.current.session).toHaveProperty('consultation');
    expect(result.current.session).toHaveProperty('relatedConsultations');
    expect(result.current.session).toHaveProperty('isLoading');
    expect(result.current.session).toHaveProperty('error');
  });
});

// =============================================================================
// HOOK-01: session.open() calls CONSULTATION_ENDPOINTS.OPEN
// =============================================================================

describe('HOOK-01: session.open() behavior', () => {
  const mockPost = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockReset();
    currentMockStore = {
      ...mockStoreDefaults,
      apiClient: { get: vi.fn(), post: mockPost, patch: vi.fn(), delete: vi.fn() },
      setSessionLoading: vi.fn(),
      setSessionError: vi.fn(),
      setConsultation: vi.fn(),
      clearContext: vi.fn(),
      addContextItem: vi.fn(),
    };
  });

  it('should POST to /consultations/open with the input', async () => {
    const mockConsultation = {
      id: 'c-001',
      patientId: 'p-123',
      doctorId: 'd-456',
      appointmentDate: '2026-02-17',
      createdAt: '2026-02-17T10:00:00Z',
      updatedAt: '2026-02-17T10:00:00Z',
      isNew: true,
    };
    mockPost.mockResolvedValue(mockConsultation);

    const { result } = renderHook(() => useArca());

    let consultation: unknown;
    await act(async () => {
      consultation = await result.current.session.open({ patientId: 'p-123' });
    });

    expect(mockPost).toHaveBeenCalledWith(
      CONSULTATION_ENDPOINTS.OPEN,
      { patientId: 'p-123' }
    );
    expect(consultation).toEqual(mockConsultation);
  });

  it('should set loading state during open', async () => {
    mockPost.mockResolvedValue({ id: 'c-001', patientId: 'p-123', doctorId: 'd-456', appointmentDate: '2026-02-17', createdAt: '', updatedAt: '' });

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.session.open({ patientId: 'p-123' });
    });

    expect(currentMockStore.setSessionLoading).toHaveBeenCalledWith(true);
    expect(currentMockStore.setSessionLoading).toHaveBeenCalledWith(false);
  });

  it('should set consultation in store after successful open', async () => {
    const mockConsultation = { id: 'c-001', patientId: 'p-123', doctorId: 'd-456', appointmentDate: '2026-02-17', createdAt: '', updatedAt: '' };
    mockPost.mockResolvedValue(mockConsultation);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.session.open({ patientId: 'p-123' });
    });

    expect(currentMockStore.setConsultation).toHaveBeenCalledWith(mockConsultation);
    expect(currentMockStore.clearContext).toHaveBeenCalled();
  });

  it('should load contextItems from consultation when present', async () => {
    const contextItem = { id: 'ctx-1', type: 'CASE_NOTE', content: 'note', source: 'USER' };
    mockPost.mockResolvedValue({
      id: 'c-001', patientId: 'p-123', doctorId: 'd-456', appointmentDate: '2026-02-17',
      createdAt: '', updatedAt: '',
      contextItems: [contextItem],
    });

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.session.open({ patientId: 'p-123' });
    });

    expect(currentMockStore.addContextItem).toHaveBeenCalledWith(contextItem);
  });

  it('should throw and set error on API failure', async () => {
    const apiError = new Error('Network error');
    mockPost.mockRejectedValue(apiError);

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => {
        await result.current.session.open({ patientId: 'p-123' });
      })
    ).rejects.toThrow('Network error');

    expect(currentMockStore.setSessionError).toHaveBeenCalledWith(apiError);
  });

  it('should throw "SDK not initialized" when apiClient is null', async () => {
    currentMockStore = { ...currentMockStore, apiClient: null };

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => {
        await result.current.session.open({ patientId: 'p-123' });
      })
    ).rejects.toThrow('SDK not initialized');
  });
});

// =============================================================================
// session.load() behavior
// =============================================================================

describe('session.load() behavior', () => {
  const mockGet = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockReset();
    currentMockStore = {
      ...mockStoreDefaults,
      apiClient: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      setSessionLoading: vi.fn(),
      setSessionError: vi.fn(),
      setConsultation: vi.fn(),
      clearContext: vi.fn(),
      addContextItem: vi.fn(),
    };
  });

  it('should GET from /consultations/:id', async () => {
    const mockConsultation = { id: 'c-001', patientId: 'p-123', doctorId: 'd-456', appointmentDate: '2026-02-17', createdAt: '', updatedAt: '' };
    mockGet.mockResolvedValue(mockConsultation);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.session.load('c-001');
    });

    expect(mockGet).toHaveBeenCalledWith(CONSULTATION_ENDPOINTS.GET('c-001'));
    expect(currentMockStore.setConsultation).toHaveBeenCalledWith(mockConsultation);
  });

  it('should throw "SDK not initialized" when apiClient is null', async () => {
    currentMockStore = { ...currentMockStore, apiClient: null };
    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => {
        await result.current.session.load('c-001');
      })
    ).rejects.toThrow('SDK not initialized');
  });
});

// =============================================================================
// session.findByPatientDate() behavior
// =============================================================================

describe('session.findByPatientDate() behavior', () => {
  const mockGet = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockReset();
    currentMockStore = {
      ...mockStoreDefaults,
      apiClient: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    };
  });

  it('should GET from the patient-date endpoint', async () => {
    mockGet.mockResolvedValue([]);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.session.findByPatientDate('p-123', '2026-02-17');
    });

    expect(mockGet).toHaveBeenCalledWith(
      CONSULTATION_ENDPOINTS.PATIENT_DATE('p-123', '2026-02-17')
    );
  });

  it('should return the list of consultations', async () => {
    const consultations = [
      { id: 'c-1', patientId: 'p-123', doctorId: 'd-1', appointmentDate: '2026-02-17', createdAt: '', updatedAt: '' },
      { id: 'c-2', patientId: 'p-123', doctorId: 'd-2', appointmentDate: '2026-02-17', createdAt: '', updatedAt: '' },
    ];
    mockGet.mockResolvedValue(consultations);

    const { result } = renderHook(() => useArca());

    let found: unknown;
    await act(async () => {
      found = await result.current.session.findByPatientDate('p-123', '2026-02-17');
    });

    expect(found).toEqual(consultations);
  });
});

// =============================================================================
// session.getPatientHistory() behavior
// =============================================================================

describe('session.getPatientHistory() behavior', () => {
  const mockGet = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockReset();
    currentMockStore = {
      ...mockStoreDefaults,
      apiClient: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    };
  });

  it('should GET from the patient history endpoint', async () => {
    mockGet.mockResolvedValue([]);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.session.getPatientHistory('p-123');
    });

    expect(mockGet).toHaveBeenCalledWith(
      CONSULTATION_ENDPOINTS.PATIENT_HISTORY('p-123')
    );
  });

  it('should append pagination query params when provided', async () => {
    mockGet.mockResolvedValue([]);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.session.getPatientHistory('p-123', { page: 2, limit: 10 });
    });

    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining(CONSULTATION_ENDPOINTS.PATIENT_HISTORY('p-123'))
    );
    const calledUrl = mockGet.mock.calls[0][0] as string;
    expect(calledUrl).toContain('page=2');
    expect(calledUrl).toContain('limit=10');
  });

  it('should not append query params when pagination is undefined', async () => {
    mockGet.mockResolvedValue([]);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.session.getPatientHistory('p-123');
    });

    const calledUrl = mockGet.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('?');
  });
});

// =============================================================================
// session.getTimeline() behavior (SES-04)
// =============================================================================

describe('session.getTimeline() behavior (SES-04)', () => {
  const mockGet = vi.fn();
  const consultationObj = { id: 'c-001', patientId: 'p-123', doctorId: 'd-456', appointmentDate: '2026-02-17', createdAt: '', updatedAt: '' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockReset();
    currentMockStore = {
      ...mockStoreDefaults,
      apiClient: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      consultation: consultationObj,
    };
  });

  it('should GET from timeline endpoint without scope by default', async () => {
    mockGet.mockResolvedValue([]);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.session.getTimeline();
    });

    expect(mockGet).toHaveBeenCalledWith(
      CONSULTATION_ENDPOINTS.TIMELINE('c-001')
    );
  });

  it('should append ?scope=chain when scope is "chain"', async () => {
    mockGet.mockResolvedValue([]);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.session.getTimeline('chain');
    });

    expect(mockGet).toHaveBeenCalledWith(
      `${CONSULTATION_ENDPOINTS.TIMELINE('c-001')}?scope=chain`
    );
  });

  it('should throw "No active consultation" when consultation is null', async () => {
    currentMockStore = { ...currentMockStore, consultation: null };

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => {
        await result.current.session.getTimeline();
      })
    ).rejects.toThrow('No active consultation');
  });
});
