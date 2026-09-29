/**
 * useArcaSummary summary-options reconciliation tests.
 *
 * Asserts that the dedicated `useArcaSummary` hook normalises legacy SDK
 * option names to the canonical backend DTO field names before POSTing:
 *
 *   - `transcript`         → `transcription`     (GenerateSummaryRequest)
 *   - `promptTemplateId`   → `template`          (GenerateSummaryRequest)
 *   - `departmentId`       → dropped (read from the consultation server-side)
 *
 * Also covers that the comprehensive-summary signature is wide enough to
 * carry `template` and `includeLabResults` to the backend.
 *
 * TASK-1012 (L-2): `generateSummary` / `generatePreSummary` POST the ASYNC routes (the
 * synchronous ones were removed by TASK-1006), poll the job and resolve the persisted note — and
 * each body carries ONLY its route DTO's fields (`forbidNonWhitelisted`): `departmentId` is dropped
 * (the gateway reads the department from the consultation), and the pre-summary DTO
 * (`GeneratePreSummaryRequest`) takes only dnaStyleId / caseNoteIds / options / idempotencyKey.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSummary } from '../useArcaSummary';
import { SUMMARY_ENDPOINTS, CONSULTATION_JOB_ENDPOINTS } from '../../core/constants';

const mockPost = vi.fn();
const mockGet = vi.fn();
const mockPatch = vi.fn();

const baseStore = () => ({
  summaries: [],
  dnaStyle: null,
  summaryGenerating: false,
  summaryError: null,
  consultation: { id: 'c-001' },
  apiClient: { get: mockGet, post: mockPost, patch: mockPatch },
  logger: null,
  initialized: true,
  setSummaryGenerating: vi.fn(),
  setSummaryError: vi.fn(),
  addSummary: vi.fn(),
  setSummaries: vi.fn(),
});

let currentStore = baseStore();

afterEach(() => {
  vi.restoreAllMocks();
});

vi.mock('../../store', () => ({
  useAgenticStore: vi.fn(() => currentStore),
}));

describe('useArcaSummary maps legacy SDK options to backend DTO field names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockReset();
    mockGet.mockReset();
    mockPatch.mockReset();
    currentStore = baseStore();
  });

  const summaryResp = {
    id: 's-1',
    contextItemId: 'ctx-1',
    content: 'Summary',
    type: 'summary',
    llmProvider: 'openai',
    modelName: 'gpt-4',
    createdAt: '',
  };

  const job = { jobId: 'job-1', status: 'pending', consultationId: 'c-001', createdAt: '' };
  const preResp = { id: 'ps-1', contextItemId: 'ctx-1', content: 'pre', type: 'pre_summary', llmProvider: 'o', modelName: 'g', createdAt: '' };

  beforeEach(() => {
    mockGet.mockImplementation(async (url: string) => {
      if (url === CONSULTATION_JOB_ENDPOINTS.GET('job-1')) return { jobId: 'job-1', status: 'COMPLETED', progress: 100 };
      if (url === SUMMARY_ENDPOINTS.LATEST('c-001')) return summaryResp;
      if (url === SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY('c-001')) return preResp;
      throw new Error(`unexpected GET ${url}`);
    });
  });

  describe('generateSummary', () => {
    it('maps `transcript` → `transcription` and strips the legacy field', async () => {
      mockPost.mockResolvedValue(job);
      const { result } = renderHook(() => useArcaSummary());

      await act(async () => {
        await result.current.generateSummary({ transcript: 'hello world' });
      });

      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'));
      expect(body).toMatchObject({ transcription: 'hello world' });
      expect(body).not.toHaveProperty('transcript');
    });

    it('maps `promptTemplateId` → `template` and strips the legacy field', async () => {
      mockPost.mockResolvedValue(job);
      const { result } = renderHook(() => useArcaSummary());

      await act(async () => {
        await result.current.generateSummary({ promptTemplateId: 'pt-1' });
      });

      const [, body] = mockPost.mock.calls[0];
      expect(body).toMatchObject({ template: 'pt-1' });
      expect(body).not.toHaveProperty('promptTemplateId');
    });

    it('drops `departmentId` (TASK-1012 — never read from the request)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockPost.mockResolvedValue(job);
      const { result } = renderHook(() => useArcaSummary());

      await act(async () => {
        await result.current.generateSummary({ departmentId: 'dept-1' });
      });

      const [, body] = mockPost.mock.calls[0];
      expect(body).not.toHaveProperty('departmentId');
      expect(body).not.toHaveProperty('options');
    });

    it('preserves caller-supplied `options` verbatim, without a departmentId', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockPost.mockResolvedValue(job);
      const { result } = renderHook(() => useArcaSummary());

      await act(async () => {
        await result.current.generateSummary({
          departmentId: 'dept-1',
          options: { foo: 'bar' },
        });
      });

      const [, body] = mockPost.mock.calls[0];
      expect(body.options).toEqual({ foo: 'bar' });
    });

    it('prefers canonical `transcription`/`template` when both forms are supplied', async () => {
      mockPost.mockResolvedValue(job);
      const { result } = renderHook(() => useArcaSummary());

      await act(async () => {
        await result.current.generateSummary({
          transcription: 'canonical',
          transcript: 'legacy',
          template: 'canonical-tpl',
          promptTemplateId: 'legacy-tpl',
        });
      });

      const [, body] = mockPost.mock.calls[0];
      expect(body).toMatchObject({
        transcription: 'canonical',
        template: 'canonical-tpl',
      });
    });

    it('forwards all canonical fields together', async () => {
      mockPost.mockResolvedValue(job);
      const { result } = renderHook(() => useArcaSummary());

      await act(async () => {
        await result.current.generateSummary({
          dnaStyleId: 'dna-1',
          includeNER: true,
          transcription: 't',
          template: 'tpl',
          contextItemIds: ['c1', 'c2'],
          options: { tone: 'concise' },
        });
      });

      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'));
      expect(body).toMatchObject({
        dnaStyleId: 'dna-1',
        includeNER: true,
        transcription: 't',
        template: 'tpl',
        contextItemIds: ['c1', 'c2'],
        options: { tone: 'concise' },
      });
      // idempotencyKey is auto-attached.
      expect(typeof body.idempotencyKey).toBe('string');
      expect(body.idempotencyKey.length).toBeGreaterThan(0);
    });

    it('posts an idempotency-keyed body to the async route and resolves the summary when no options are supplied', async () => {
      mockPost.mockResolvedValue(job);
      const { result } = renderHook(() => useArcaSummary());

      let resolved: unknown;
      await act(async () => {
        resolved = await result.current.generateSummary();
      });

      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'));
      expect(typeof body.idempotencyKey).toBe('string');
      expect(resolved).toEqual(summaryResp);
      expect(currentStore.addSummary).toHaveBeenCalledWith(summaryResp);
    });
  });

  describe('generatePreSummary / async POSTs', () => {
    it('generatePreSummary sends only GeneratePreSummaryRequest fields (TASK-1012)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockPost.mockResolvedValue(job);
      const { result } = renderHook(() => useArcaSummary());

      let resolved: unknown;
      await act(async () => {
        resolved = await result.current.generatePreSummary({
          dnaStyleId: 'dna-1',
          transcript: 'tx',
          promptTemplateId: 'pt',
          departmentId: 'dept',
        });
      });

      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe(SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC('c-001'));
      expect(Object.keys(body).sort()).toEqual(['dnaStyleId', 'idempotencyKey']);
      expect(body.dnaStyleId).toBe('dna-1');
      expect(resolved).toEqual(preResp);
    });

    it('generateSummaryAsync maps legacy fields', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockPost.mockResolvedValue(job);
      const { result } = renderHook(() => useArcaSummary());

      await act(async () => {
        await result.current.generateSummaryAsync({
          transcript: 'tx',
          promptTemplateId: 'pt',
          departmentId: 'dept',
        });
      });

      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'));
      expect(body).toMatchObject({ transcription: 'tx', template: 'pt' });
      expect(body).not.toHaveProperty('options');
    });

    it('generatePreSummaryAsync drops the fields GeneratePreSummaryRequest does not declare (TASK-1012)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockPost.mockResolvedValue(job);
      const { result } = renderHook(() => useArcaSummary());

      await act(async () => {
        await result.current.generatePreSummaryAsync({
          transcript: 'tx',
          promptTemplateId: 'pt',
          departmentId: 'dept',
        });
      });

      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe(SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC('c-001'));
      expect(Object.keys(body)).toEqual(['idempotencyKey']);
    });

    it('generateSummaryAsync posts a body with idempotencyKey when called without options', async () => {
      mockPost.mockResolvedValue(job);
      const { result } = renderHook(() => useArcaSummary());

      await act(async () => {
        await result.current.generateSummaryAsync();
      });

      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'));
      // Async POSTs always carry an idempotencyKey so
      // double-clicks dedupe to the same backend job.
      expect(typeof body.idempotencyKey).toBe('string');
      expect(body.idempotencyKey.length).toBeGreaterThan(0);
    });
  });
});

describe('useArcaSummary.generateComprehensiveSummary signature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockReset();
    currentStore = baseStore();
  });

  it('accepts `template`, `includeLabResults`, and `options` and forwards them verbatim', async () => {
    const compResp = { id: 'cs-1', content: 'comprehensive', consultationIds: ['c-001'], createdAt: '' };
    mockPost.mockResolvedValue(compResp);
    const { result } = renderHook(() => useArcaSummary());

    await act(async () => {
      await result.current.generateComprehensiveSummary({
        dnaStyleId: 'dna-1',
        template: 'comprehensive',
        includeNER: true,
        includeLabResults: false,
        options: { tone: 'concise' },
      });
    });

    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe(SUMMARY_ENDPOINTS.COMPREHENSIVE('c-001'));
    expect(body).toMatchObject({
      dnaStyleId: 'dna-1',
      template: 'comprehensive',
      includeNER: true,
      includeLabResults: false,
      options: { tone: 'concise' },
    });
    // Comprehensive POSTs are side-effectful; idempotency-key required.
    expect(typeof body.idempotencyKey).toBe('string');
  });

  it('repeated calls mint distinct idempotency keys per user-action', async () => {
    mockPost.mockResolvedValue({ id: 'cs', content: '', consultationIds: [], createdAt: '' });
    const { result } = renderHook(() => useArcaSummary());

    await act(async () => {
      await result.current.generateComprehensiveSummary({ dnaStyleId: 'd' });
      await result.current.generateComprehensiveSummary({ dnaStyleId: 'd' });
    });

    const k1 = mockPost.mock.calls[0][1].idempotencyKey;
    const k2 = mockPost.mock.calls[1][1].idempotencyKey;
    expect(k1).not.toBe(k2);
  });

  it('caller-supplied idempotencyKey is honored verbatim', async () => {
    mockPost.mockResolvedValue({ id: 'cs', content: '', consultationIds: [], createdAt: '' });
    const { result } = renderHook(() => useArcaSummary());

    await act(async () => {
      await result.current.generateComprehensiveSummary({
        dnaStyleId: 'd',
        idempotencyKey: 'caller-explicit-key',
      });
    });

    const body = mockPost.mock.calls[0][1];
    expect(body.idempotencyKey).toBe('caller-explicit-key');
    // The hint field is consumed and not echoed alongside itself.
    expect(Object.keys(body).filter((k) => k === 'idempotencyKey')).toHaveLength(1);
  });
});
