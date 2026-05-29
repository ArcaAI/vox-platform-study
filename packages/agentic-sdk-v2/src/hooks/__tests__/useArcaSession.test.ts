/**
 * useArcaSession Hook Tests
 *
 * Tests for the simplified session management hook.
 * Current API: open, addContext, getSharedContext, getPatientHistory,
 *              loadConsultation, loadSummaries
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSession } from '../useArcaSession';
import { useAgenticStore } from '../../store/agenticStore';
import { AgenticClient } from '../../core/AgenticClient';
import { createCrossTabSync } from '../../core/SimpleCrossTabSync';
import { createMockLogger, mockFetch, createMockResponse, createMockConsultation, createMockContextItem } from '../../__tests__/setup';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return {
        ...actual,
        useAgenticStore: vi.fn(),
    };
});

const mockCrossTabSync = {
    onContextAdded: vi.fn(),
    broadcastContext: vi.fn(),
    close: vi.fn(),
};

vi.mock('../../core/SimpleCrossTabSync', () => ({
    SimpleCrossTabSync: vi.fn(),
    createCrossTabSync: vi.fn(() => ({
        onContextAdded: vi.fn(),
        broadcastContext: vi.fn(),
        close: vi.fn(),
    })),
}));

describe('useArcaSession', () => {
    let mockApiClient: AgenticClient;
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockApiClient = new AgenticClient(
            { baseUrl: 'http://test', apiKey: 'key' },
            mockLogger
        );

        mockStore = {
            apiClient: mockApiClient,
            consultation: null,
            contextItems: [],
            sessionLoading: false,
            sessionError: null,
            summaries: [],
            logger: mockLogger,
            setConsultation: vi.fn(),
            setSessionLoading: vi.fn(),
            setSessionError: vi.fn(),
            clearContext: vi.fn(),
            addContextItem: vi.fn(),
            setSharedContext: vi.fn(),
            setSummaries: vi.fn(),
            reset: vi.fn(),
        };

        (useAgenticStore as any).mockReturnValue(mockStore);

        (createCrossTabSync as any).mockReturnValue({
            onContextAdded: vi.fn(),
            broadcastContext: vi.fn(),
            close: vi.fn(),
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('initial state', () => {
        it('should return initial state with correct shape', () => {
            const { result } = renderHook(() => useArcaSession());

            expect(result.current.consultation).toBeNull();
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
            expect(typeof result.current.open).toBe('function');
            expect(typeof result.current.addContext).toBe('function');
            expect(typeof result.current.getSharedContext).toBe('function');
            expect(typeof result.current.getPatientHistory).toBe('function');
            expect(typeof result.current.loadConsultation).toBe('function');
            expect(typeof result.current.loadSummaries).toBe('function');
        });

        it('should NOT expose stale lifecycle methods', () => {
            const { result } = renderHook(() => useArcaSession());
            const keys = Object.keys(result.current);
            expect(keys).not.toContain('create');
            expect(keys).not.toContain('end');
            expect(keys).not.toContain('pause');
            expect(keys).not.toContain('resume');
            expect(keys).not.toContain('startRevisit');
            expect(keys).not.toContain('findByPatientDate');
        });

        it('should return context items from store', () => {
            const items = [createMockContextItem({ id: 'ctx-1' })];
            mockStore.contextItems = items;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaSession());
            expect(result.current.context).toEqual(items);
        });

        it('should map consultation state from store', () => {
            mockStore.consultation = {
                id: 'cons-1',
                patientId: 'p1',
                doctorId: 'd1',
                doctorName: 'Dr Smith',
                appointmentDate: '2026-02-19',
                department: 'Cardiology',
                metadata: { key: 'val' },
                createdAt: '2026-02-19T00:00:00Z',
                updatedAt: '2026-02-19T00:00:00Z',
            };
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaSession());
            expect(result.current.consultation).toEqual({
                id: 'cons-1',
                patientId: 'p1',
                doctorId: 'd1',
                doctorName: 'Dr Smith',
                appointmentDate: '2026-02-19',
                department: 'Cardiology',
                metadata: { key: 'val' },
                createdAt: '2026-02-19T00:00:00Z',
                updatedAt: '2026-02-19T00:00:00Z',
            });
        });

        it('should reflect loading and error state from store', () => {
            mockStore.sessionLoading = true;
            mockStore.sessionError = new Error('test error');
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaSession());
            expect(result.current.isLoading).toBe(true);
            expect(result.current.error).toEqual(new Error('test error'));
        });
    });

    describe('open', () => {
        it('should open a consultation via get-or-create', async () => {
            const mockConsultation = createMockConsultation({ id: 'cons-123', isNew: true });
            mockFetch.mockResolvedValueOnce(createMockResponse(mockConsultation));

            const { result } = renderHook(() => useArcaSession());

            let consultation: any;
            await act(async () => {
                consultation = await result.current.open({
                    patientId: 'patient-123',
                    appointmentDate: '2026-02-17',
                });
            });

            expect(mockStore.setSessionLoading).toHaveBeenCalledWith(true);
            expect(mockStore.setSessionError).toHaveBeenCalledWith(null);
            expect(mockStore.setConsultation).toHaveBeenCalled();
            expect(mockStore.clearContext).toHaveBeenCalled();
            expect(consultation.id).toBe('cons-123');
        });

        it('should populate context items when consultation has them', async () => {
            const contextItems = [
                createMockContextItem({ id: 'ctx-1', type: 'case_note' }),
                createMockContextItem({ id: 'ctx-2', type: 'transcription' }),
            ];
            const mockConsultation = createMockConsultation({
                id: 'cons-with-ctx',
                contextItems,
            });
            mockFetch.mockResolvedValueOnce(createMockResponse(mockConsultation));

            const { result } = renderHook(() => useArcaSession());

            await act(async () => {
                await result.current.open({
                    patientId: 'patient-123',
                    appointmentDate: '2026-02-17',
                });
            });

            expect(mockStore.addContextItem).toHaveBeenCalledTimes(2);
            expect(mockStore.addContextItem).toHaveBeenCalledWith(contextItems[0]);
            expect(mockStore.addContextItem).toHaveBeenCalledWith(contextItems[1]);
        });

        it('should set up cross-tab sync after opening', async () => {
            const mockConsultation = createMockConsultation({
                id: 'cons-sync',
                patientId: 'p1',
                doctorId: 'd1',
                appointmentDate: '2026-02-17',
            });
            mockFetch.mockResolvedValueOnce(createMockResponse(mockConsultation));

            const { result } = renderHook(() => useArcaSession());

            await act(async () => {
                await result.current.open({
                    patientId: 'p1',
                    appointmentDate: '2026-02-17',
                });
            });

            expect(createCrossTabSync).toHaveBeenCalledWith(
                expect.objectContaining({
                    patientId: mockConsultation.patientId,
                    doctorId: mockConsultation.doctorId,
                }),
                // TASK-317 D-5 (AC-9) — options arg is always present; this test
                // seeds no tenant, so it only asserts the call shape (the strict
                // tenantId assertion lives in the dedicated AC-9 test below).
                expect.objectContaining({})
            );
        });

        // =====================================================================
        // TASK-317 W3.3 — AC-9: cross-tab sync MUST be namespaced per tenant.
        //
        // SimpleCrossTabSync already supports `options.tenantId` (channel name
        // becomes `agentic.<tenantId>`), but useArcaSession never passed it, so
        // every tenant shared the hashed-consultation channel — a cross-tenant
        // context-bleed risk. This asserts the hook forwards the active tenant
        // id (resolved from the api client) into createCrossTabSync options.
        // =====================================================================
        it('TASK-317 W3.3 — AC-9 passes the active tenantId into createCrossTabSync options', async () => {
            mockApiClient.updateTenantId('tenant-xyz');

            const mockConsultation = createMockConsultation({
                id: 'cons-tenant',
                patientId: 'p1',
                doctorId: 'd1',
                appointmentDate: '2026-02-17',
            });
            mockFetch.mockResolvedValueOnce(createMockResponse(mockConsultation));

            const { result } = renderHook(() => useArcaSession());

            await act(async () => {
                await result.current.open({
                    patientId: 'p1',
                    appointmentDate: '2026-02-17',
                });
            });

            expect(createCrossTabSync).toHaveBeenCalledWith(
                expect.objectContaining({
                    patientId: mockConsultation.patientId,
                    doctorId: mockConsultation.doctorId,
                }),
                expect.objectContaining({ tenantId: 'tenant-xyz' })
            );
        });

        it('should close previous cross-tab sync when opening new consultation', async () => {
            const closeFn = vi.fn();
            (createCrossTabSync as any).mockReturnValue({
                onContextAdded: vi.fn(),
                broadcastContext: vi.fn(),
                close: closeFn,
            });

            const cons1 = createMockConsultation({ id: 'cons-1' });
            const cons2 = createMockConsultation({ id: 'cons-2' });
            mockFetch
                .mockResolvedValueOnce(createMockResponse(cons1))
                .mockResolvedValueOnce(createMockResponse(cons2));

            const { result } = renderHook(() => useArcaSession());

            await act(async () => {
                await result.current.open({ patientId: 'p1', appointmentDate: '2026-02-17' });
            });

            await act(async () => {
                await result.current.open({ patientId: 'p2', appointmentDate: '2026-02-18' });
            });

            expect(closeFn).toHaveBeenCalled();
        });

        it('should set error on failure', async () => {
            const error = new Error('Open failed');
            mockFetch.mockRejectedValueOnce(error);

            const { result } = renderHook(() => useArcaSession());

            await act(async () => {
                try {
                    await result.current.open({
                        patientId: 'patient-123',
                        appointmentDate: '2026-02-17',
                    });
                } catch { /* expected */ }
            });

            expect(mockStore.setSessionError).toHaveBeenCalled();
            expect(mockStore.setSessionLoading).toHaveBeenCalledWith(false);
        });

        it('should always set loading false in finally block', async () => {
            mockFetch.mockRejectedValueOnce(new TypeError('Network'));

            const { result } = renderHook(() => useArcaSession());

            await act(async () => {
                try {
                    await result.current.open({ patientId: 'p1', appointmentDate: '2026-02-17' });
                } catch { /* expected */ }
            });

            const loadingCalls = mockStore.setSessionLoading.mock.calls;
            expect(loadingCalls[0][0]).toBe(true);
            expect(loadingCalls[loadingCalls.length - 1][0]).toBe(false);
        });

        it('should throw when SDK not initialized', async () => {
            mockStore.apiClient = undefined;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaSession());

            await expect(
                act(async () => {
                    await result.current.open({
                        patientId: 'patient-123',
                        appointmentDate: '2026-02-17',
                    });
                })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('addContext', () => {
        it('should add context to an open consultation', async () => {
            mockStore.consultation = createMockConsultation({ id: 'cons-123' });
            (useAgenticStore as any).mockReturnValue(mockStore);

            const newContext = createMockContextItem({
                id: 'ctx-new',
                consultationId: 'cons-123',
                type: 'case_note',
                content: 'Patient reports headache',
            });
            mockFetch.mockResolvedValueOnce(createMockResponse(newContext));

            const { result } = renderHook(() => useArcaSession());

            let returnedCtx: any;
            await act(async () => {
                returnedCtx = await result.current.addContext({
                    type: 'case_note',
                    content: 'Patient reports headache',
                });
            });

            expect(returnedCtx.id).toBe('ctx-new');
            expect(mockStore.addContextItem).toHaveBeenCalledWith(newContext);
        });

        it('should broadcast context to other tabs via cross-tab sync', async () => {
            const broadcastFn = vi.fn();
            (createCrossTabSync as any).mockReturnValue({
                onContextAdded: vi.fn(),
                broadcastContext: broadcastFn,
                close: vi.fn(),
            });

            const openConsultation = createMockConsultation({ id: 'cons-456' });
            mockFetch.mockResolvedValueOnce(createMockResponse(openConsultation));

            const { result } = renderHook(() => useArcaSession());

            await act(async () => {
                await result.current.open({ patientId: 'p1', appointmentDate: '2026-02-17' });
            });

            const newContext = createMockContextItem({ id: 'ctx-broadcast' });
            mockFetch.mockResolvedValueOnce(createMockResponse(newContext));

            mockStore.consultation = openConsultation;
            (useAgenticStore as any).mockReturnValue(mockStore);

            await act(async () => {
                await result.current.addContext({ type: 'transcription', content: 'Hello world' });
            });

            expect(broadcastFn).toHaveBeenCalledWith(newContext);
        });

        it('should throw when no consultation is open', async () => {
            const { result } = renderHook(() => useArcaSession());

            await expect(
                act(async () => {
                    await result.current.addContext({ type: 'transcription', content: 'test' });
                })
            ).rejects.toThrow('No consultation open');
        });

        it('should throw when SDK not initialized', async () => {
            mockStore.apiClient = undefined;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaSession());

            await expect(
                act(async () => {
                    await result.current.addContext({ type: 'transcription', content: 'test' });
                })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should propagate API errors', async () => {
            mockStore.consultation = createMockConsultation({ id: 'cons-err' });
            (useAgenticStore as any).mockReturnValue(mockStore);

            mockFetch.mockRejectedValueOnce(new TypeError('Network error'));

            const { result } = renderHook(() => useArcaSession());

            await expect(
                act(async () => {
                    await result.current.addContext({ type: 'case_note', content: 'test' });
                })
            ).rejects.toThrow();
        });
    });

    describe('getSharedContext', () => {
        it('should fetch and store shared context', async () => {
            mockStore.consultation = createMockConsultation({ id: 'cons-shared' });
            (useAgenticStore as any).mockReturnValue(mockStore);

            const sharedItems = [
                createMockContextItem({ id: 'shared-1', type: 'case_note' }),
                createMockContextItem({ id: 'shared-2', type: 'case_note' }),
            ];
            mockFetch.mockResolvedValueOnce(createMockResponse(sharedItems));

            const { result } = renderHook(() => useArcaSession());

            let shared: any[];
            await act(async () => {
                shared = await result.current.getSharedContext();
            });

            expect(shared!).toHaveLength(2);
            expect(mockStore.setSharedContext).toHaveBeenCalledWith(sharedItems);
        });

        it('should throw when no consultation is open', async () => {
            const { result } = renderHook(() => useArcaSession());

            await expect(
                act(async () => {
                    await result.current.getSharedContext();
                })
            ).rejects.toThrow('No consultation open');
        });

        it('should throw when SDK not initialized', async () => {
            mockStore.apiClient = undefined;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaSession());

            await expect(
                act(async () => {
                    await result.current.getSharedContext();
                })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('loadConsultation', () => {
        it('should load a consultation by ID', async () => {
            const mockConsultation = createMockConsultation({ id: 'existing-123' });
            mockFetch.mockResolvedValueOnce(createMockResponse(mockConsultation));

            const { result } = renderHook(() => useArcaSession());

            let loaded: any;
            await act(async () => {
                loaded = await result.current.loadConsultation('existing-123');
            });

            expect(loaded.id).toBe('existing-123');
            expect(mockStore.setSessionLoading).toHaveBeenCalledWith(true);
            expect(mockStore.setSessionError).toHaveBeenCalledWith(null);
            expect(mockStore.setConsultation).toHaveBeenCalled();
            expect(mockStore.clearContext).toHaveBeenCalled();
        });

        it('should populate context items from loaded consultation', async () => {
            const contextItems = [createMockContextItem({ id: 'loaded-ctx' })];
            const mockConsultation = createMockConsultation({
                id: 'load-with-ctx',
                contextItems,
            });
            mockFetch.mockResolvedValueOnce(createMockResponse(mockConsultation));

            const { result } = renderHook(() => useArcaSession());

            await act(async () => {
                await result.current.loadConsultation('load-with-ctx');
            });

            expect(mockStore.addContextItem).toHaveBeenCalledWith(contextItems[0]);
        });

        it('should set up cross-tab sync after loading', async () => {
            const mockConsultation = createMockConsultation({
                id: 'load-sync',
                patientId: 'p1',
                doctorId: 'd1',
            });
            mockFetch.mockResolvedValueOnce(createMockResponse(mockConsultation));

            const { result } = renderHook(() => useArcaSession());

            await act(async () => {
                await result.current.loadConsultation('load-sync');
            });

            expect(createCrossTabSync).toHaveBeenCalled();
        });

        it('should set error on failure', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Load failed'));

            const { result } = renderHook(() => useArcaSession());

            await act(async () => {
                try {
                    await result.current.loadConsultation('bad-id');
                } catch { /* expected */ }
            });

            expect(mockStore.setSessionError).toHaveBeenCalled();
            expect(mockStore.setSessionLoading).toHaveBeenCalledWith(false);
        });

        it('should throw when SDK not initialized', async () => {
            mockStore.apiClient = undefined;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaSession());

            await expect(
                act(async () => {
                    await result.current.loadConsultation('existing-123');
                })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('getPatientHistory', () => {
        it('should fetch patient consultation history', async () => {
            const mockConsultations = [
                createMockConsultation({ id: '1', patientId: 'patient-123' }),
                createMockConsultation({ id: '2', patientId: 'patient-123' }),
            ];
            mockFetch.mockResolvedValueOnce(createMockResponse(mockConsultations));

            const { result } = renderHook(() => useArcaSession());

            let history: any[];
            await act(async () => {
                history = await result.current.getPatientHistory('patient-123');
            });

            expect(history!).toHaveLength(2);
        });

        it('should return empty array for patient with no history', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse([]));

            const { result } = renderHook(() => useArcaSession());

            let history: any[];
            await act(async () => {
                history = await result.current.getPatientHistory('new-patient');
            });

            expect(history!).toHaveLength(0);
        });

        it('should throw when SDK not initialized', async () => {
            mockStore.apiClient = undefined;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaSession());

            await expect(
                act(async () => {
                    await result.current.getPatientHistory('patient-123');
                })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('loadSummaries', () => {
        it('should load and store summaries for current consultation', async () => {
            mockStore.consultation = createMockConsultation({ id: 'cons-sum' });
            (useAgenticStore as any).mockReturnValue(mockStore);

            const summaries = [
                { id: 'sum-1', type: 'pre_summary', content: 'Pre-summary text' },
                { id: 'sum-2', type: 'raw_summary', content: 'Summary text' },
            ];
            mockFetch.mockResolvedValueOnce(createMockResponse(summaries));

            const { result } = renderHook(() => useArcaSession());

            let loaded: any[];
            await act(async () => {
                loaded = await result.current.loadSummaries();
            });

            expect(loaded!).toHaveLength(2);
            expect(mockStore.setSummaries).toHaveBeenCalledWith(summaries);
        });

        it('should throw when no consultation is open', async () => {
            const { result } = renderHook(() => useArcaSession());

            await expect(
                act(async () => {
                    await result.current.loadSummaries();
                })
            ).rejects.toThrow();
        });

        it('should throw when SDK not initialized', async () => {
            mockStore.apiClient = undefined;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaSession());

            await expect(
                act(async () => {
                    await result.current.loadSummaries();
                })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('cross-tab sync cleanup', () => {
        it('should close cross-tab sync on unmount', async () => {
            const closeFn = vi.fn();
            (createCrossTabSync as any).mockReturnValue({
                onContextAdded: vi.fn(),
                broadcastContext: vi.fn(),
                close: closeFn,
            });

            const mockConsultation = createMockConsultation({ id: 'cons-unmount' });
            mockFetch.mockResolvedValueOnce(createMockResponse(mockConsultation));

            const { result, unmount } = renderHook(() => useArcaSession());

            await act(async () => {
                await result.current.open({ patientId: 'p1', appointmentDate: '2026-02-17' });
            });

            unmount();
            expect(closeFn).toHaveBeenCalled();
        });
    });

    describe('full consultation workflow', () => {
        it('should support open → addContext → getSharedContext → loadSummaries', async () => {
            const consultation = createMockConsultation({ id: 'wf-1', patientId: 'p1' });
            mockFetch.mockResolvedValueOnce(createMockResponse(consultation));

            const { result } = renderHook(() => useArcaSession());

            await act(async () => {
                await result.current.open({ patientId: 'p1', appointmentDate: '2026-02-17' });
            });

            mockStore.consultation = consultation;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const contextItem = createMockContextItem({ id: 'ctx-wf', type: 'case_note' });
            mockFetch.mockResolvedValueOnce(createMockResponse(contextItem));

            await act(async () => {
                await result.current.addContext({ type: 'case_note', content: 'Patient has fever' });
            });

            expect(mockStore.addContextItem).toHaveBeenCalledWith(contextItem);

            const sharedItems = [createMockContextItem({ id: 'shared-wf' })];
            mockFetch.mockResolvedValueOnce(createMockResponse(sharedItems));

            await act(async () => {
                await result.current.getSharedContext();
            });

            expect(mockStore.setSharedContext).toHaveBeenCalledWith(sharedItems);

            const summaries = [{ id: 'sum-wf', type: 'raw_summary', content: 'Summary' }];
            mockFetch.mockResolvedValueOnce(createMockResponse(summaries));

            await act(async () => {
                await result.current.loadSummaries();
            });

            expect(mockStore.setSummaries).toHaveBeenCalledWith(summaries);
        });
    });
});
