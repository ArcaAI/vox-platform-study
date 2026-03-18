/**
 * useArcaConfig Hook Tests
 *
 * Tests for configuration and personalization functionality.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { useArcaConfig } from '../useArcaConfig';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import type { ModelDefinition } from '../../types';

// Mock the store
vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return {
        ...actual,
        useAgenticStore: vi.fn(),
    };
});

describe('useArcaConfig', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    let mockPersonalizationManager: any;
    let mockModelRegistry: any;

    beforeEach(() => {
        mockLogger = createMockLogger();

        mockPersonalizationManager = {
            getPreferences: vi.fn().mockReturnValue({ language: 'en', theme: 'light' }),
            updatePreferences: vi.fn().mockResolvedValue(undefined),
            reset: vi.fn().mockResolvedValue(undefined),
        };

        const mockModels: ModelDefinition[] = [
            { id: 'whisper-tiny', name: 'Whisper Tiny', type: 'stt', source: 'huggingface' },
            { id: 'whisper-base', name: 'Whisper Base', type: 'stt', source: 'huggingface' },
            { id: 'silero-vad', name: 'Silero VAD', type: 'vad', source: 'huggingface' },
        ];

        mockModelRegistry = {
            getModelsByType: vi.fn((type: string) => mockModels.filter(m => m.type === type)),
            getSelected: vi.fn().mockReturnValue({ stt: 'whisper-tiny' }),
            selectModel: vi.fn(),
        };

        mockStore = {
            preferences: { language: 'en', theme: 'light' },
            personalizationManager: mockPersonalizationManager,
            modelRegistry: mockModelRegistry,
            logger: mockLogger,
            updatePreferences: vi.fn(),
            setPreferences: vi.fn(),
        };

        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('initial state', () => {
        it('should return preferences', () => {
            const { result } = renderHook(() => useArcaConfig());

            expect(result.current.preferences).toEqual({ language: 'en', theme: 'light' });
        });

        it('should return models grouped by type', () => {
            const { result } = renderHook(() => useArcaConfig());

            expect(result.current.models.stt).toHaveLength(2);
            expect(result.current.models.vad).toHaveLength(1);
            expect(result.current.models.ner).toHaveLength(0);
            expect(result.current.models.selected.stt).toBe('whisper-tiny');
        });

        it('should return empty models when registry not available', () => {
            mockStore.modelRegistry = null;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaConfig());

            expect(result.current.models.stt).toEqual([]);
            expect(result.current.models.vad).toEqual([]);
            expect(result.current.models.ner).toEqual([]);
            expect(result.current.models.selected).toEqual({});
        });
    });

    describe('get', () => {
        it('should return specific preference value', () => {
            const { result } = renderHook(() => useArcaConfig());

            expect(result.current.get('language')).toBe('en');
            expect(result.current.get('theme')).toBe('light');
        });
    });

    describe('update', () => {
        it('should update preferences via manager', async () => {
            const { result } = renderHook(() => useArcaConfig());

            await act(async () => {
                await result.current.update({ language: 'th' });
            });

            expect(mockPersonalizationManager.updatePreferences).toHaveBeenCalledWith({ language: 'th' });
            expect(mockStore.setPreferences).toHaveBeenCalled();
        });

        it('should fallback to local update when manager not available', async () => {
            mockStore.personalizationManager = null;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaConfig());

            await act(async () => {
                await result.current.update({ language: 'th' });
            });

            expect(mockStore.updatePreferences).toHaveBeenCalledWith({ language: 'th' });
        });
    });

    describe('reset', () => {
        it('should reset preferences to defaults', async () => {
            const { result } = renderHook(() => useArcaConfig());

            await act(async () => {
                await result.current.reset();
            });

            expect(mockPersonalizationManager.reset).toHaveBeenCalled();
            expect(mockStore.setPreferences).toHaveBeenCalled();
        });

        it('should do nothing when manager not available', async () => {
            mockStore.personalizationManager = null;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaConfig());

            await act(async () => {
                await result.current.reset();
            });

            expect(mockStore.setPreferences).not.toHaveBeenCalled();
        });
    });

    describe('selectModel', () => {
        it('should select model via registry', () => {
            const { result } = renderHook(() => useArcaConfig());

            act(() => {
                result.current.selectModel('stt', 'whisper-base');
            });

            expect(mockModelRegistry.selectModel).toHaveBeenCalledWith('stt', 'whisper-base');
        });

        it('should do nothing when registry not available', () => {
            mockStore.modelRegistry = null;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaConfig());

            act(() => {
                result.current.selectModel('stt', 'whisper-base');
            });

            // Should not throw
        });
    });
});
