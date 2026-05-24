/**
 * useArcaSummary summary-options reconciliation tests — TASK-299 D-4 + D-17.
 *
 * Asserts that the dedicated `useArcaSummary` hook normalises legacy SDK
 * option names to the canonical backend DTO field names before POSTing:
 *
 *   - `transcript`         → `transcription`     (GenerateSummaryRequest)
 *   - `promptTemplateId`   → `template`          (GenerateSummaryRequest)
 *   - `departmentId`       → `options.departmentId` (no first-class field)
 *
 * Also covers D-17: the comprehensive-summary signature is wide enough to
 * carry `template` and `includeLabResults` to the backend.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSummary } from '../useArcaSummary';
import { SUMMARY_ENDPOINTS } from '../../core/constants';

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

vi.mock('../../store', () => ({
    useAgenticStore: vi.fn(() => currentStore),
}));

describe('TASK-299 D-4 — useArcaSummary maps legacy SDK options to backend DTO field names', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPost.mockReset();
        mockGet.mockReset();
        mockPatch.mockReset();
        currentStore = baseStore();
    });

    const summaryResp = {
        id: 's-1', contextItemId: 'ctx-1', content: 'Summary',
        type: 'summary', llmProvider: 'openai', modelName: 'gpt-4', createdAt: '',
    };

    describe('generateSummary', () => {
        it('maps `transcript` → `transcription` and strips the legacy field', async () => {
            mockPost.mockResolvedValue(summaryResp);
            const { result } = renderHook(() => useArcaSummary());

            await act(async () => {
                await result.current.generateSummary({ transcript: 'hello world' });
            });

            const [url, body] = mockPost.mock.calls[0];
            expect(url).toBe(SUMMARY_ENDPOINTS.GENERATE('c-001'));
            expect(body).toMatchObject({ transcription: 'hello world' });
            expect(body).not.toHaveProperty('transcript');
        });

        it('maps `promptTemplateId` → `template` and strips the legacy field', async () => {
            mockPost.mockResolvedValue(summaryResp);
            const { result } = renderHook(() => useArcaSummary());

            await act(async () => {
                await result.current.generateSummary({ promptTemplateId: 'pt-1' });
            });

            const [, body] = mockPost.mock.calls[0];
            expect(body).toMatchObject({ template: 'pt-1' });
            expect(body).not.toHaveProperty('promptTemplateId');
        });

        it('tucks `departmentId` under `options.departmentId`', async () => {
            mockPost.mockResolvedValue(summaryResp);
            const { result } = renderHook(() => useArcaSummary());

            await act(async () => {
                await result.current.generateSummary({ departmentId: 'dept-1' });
            });

            const [, body] = mockPost.mock.calls[0];
            expect(body).toMatchObject({ options: { departmentId: 'dept-1' } });
            expect(body).not.toHaveProperty('departmentId');
        });

        it('preserves caller-supplied `options` alongside `departmentId`', async () => {
            mockPost.mockResolvedValue(summaryResp);
            const { result } = renderHook(() => useArcaSummary());

            await act(async () => {
                await result.current.generateSummary({
                    departmentId: 'dept-1',
                    options: { foo: 'bar' },
                });
            });

            const [, body] = mockPost.mock.calls[0];
            expect(body.options).toEqual({ foo: 'bar', departmentId: 'dept-1' });
        });

        it('prefers canonical `transcription`/`template` when both forms are supplied', async () => {
            mockPost.mockResolvedValue(summaryResp);
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
            mockPost.mockResolvedValue(summaryResp);
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
            expect(url).toBe(SUMMARY_ENDPOINTS.GENERATE('c-001'));
            expect(body).toMatchObject({
                dnaStyleId: 'dna-1',
                includeNER: true,
                transcription: 't',
                template: 'tpl',
                contextItemIds: ['c1', 'c2'],
                options: { tone: 'concise' },
            });
            // TASK-299 D-9 — idempotencyKey is auto-attached.
            expect(typeof body.idempotencyKey).toBe('string');
            expect(body.idempotencyKey.length).toBeGreaterThan(0);
        });

        it('passes `undefined` body when no options supplied', async () => {
            mockPost.mockResolvedValue(summaryResp);
            const { result } = renderHook(() => useArcaSummary());

            await act(async () => {
                await result.current.generateSummary();
            });

            // TASK-299 D-9 — no body means no idempotency-key injection either
            // (back-compat: this is the legacy "no options" path).
            expect(mockPost).toHaveBeenCalledWith(SUMMARY_ENDPOINTS.GENERATE('c-001'), undefined);
        });
    });

    describe('generatePreSummary / async POSTs', () => {
        const preResp = { id: 'ps-1', contextItemId: 'ctx-1', content: 'pre', type: 'pre_summary', llmProvider: 'o', modelName: 'g', createdAt: '' };
        const job = { jobId: 'job-1', status: 'pending', consultationId: 'c-001', createdAt: '' };

        it('generatePreSummary maps legacy fields', async () => {
            mockPost.mockResolvedValue(preResp);
            const { result } = renderHook(() => useArcaSummary());

            await act(async () => {
                await result.current.generatePreSummary({
                    dnaStyleId: 'dna-1',
                    transcript: 'tx',
                    promptTemplateId: 'pt',
                    departmentId: 'dept',
                });
            });

            const [url, body] = mockPost.mock.calls[0];
            expect(url).toBe(SUMMARY_ENDPOINTS.PRE_SUMMARY('c-001'));
            expect(body).toMatchObject({
                dnaStyleId: 'dna-1',
                transcription: 'tx',
                template: 'pt',
                options: { departmentId: 'dept' },
            });
        });

        it('generateSummaryAsync maps legacy fields', async () => {
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
            expect(body).toMatchObject({
                transcription: 'tx',
                template: 'pt',
                options: { departmentId: 'dept' },
            });
        });

        it('generatePreSummaryAsync maps legacy fields', async () => {
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
            expect(body).toMatchObject({
                transcription: 'tx',
                template: 'pt',
                options: { departmentId: 'dept' },
            });
        });

        it('generateSummaryAsync posts a body with idempotencyKey when called without options', async () => {
            mockPost.mockResolvedValue(job);
            const { result } = renderHook(() => useArcaSummary());

            await act(async () => {
                await result.current.generateSummaryAsync();
            });

            const [url, body] = mockPost.mock.calls[0];
            expect(url).toBe(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'));
            // TASK-299 D-9 — async POSTs always carry an idempotencyKey so
            // double-clicks dedupe to the same backend job.
            expect(typeof body.idempotencyKey).toBe('string');
            expect(body.idempotencyKey.length).toBeGreaterThan(0);
        });
    });
});

describe('TASK-299 D-17 — useArcaSummary.generateComprehensiveSummary signature', () => {
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
        // TASK-299 D-9 — comprehensive POSTs are side-effectful; idempotency-key required.
        expect(typeof body.idempotencyKey).toBe('string');
    });

    it('TASK-299 D-9 — repeated calls mint distinct idempotency keys per user-action', async () => {
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

    it('TASK-299 D-9 — caller-supplied idempotencyKey is honored verbatim', async () => {
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
