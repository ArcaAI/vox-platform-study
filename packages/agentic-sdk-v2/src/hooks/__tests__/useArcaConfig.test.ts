/**
 * useArcaConfig Hook Tests (M-001 — selectModel re-render fix)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaConfig } from '../useArcaConfig';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { AgenticError } from '../../types';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

function createMockModelRegistry() {
    const models = new Map([
        ['whisper-tiny', { id: 'whisper-tiny', name: 'Whisper Tiny', type: 'stt', source: 'huggingface' }],
        ['whisper-base', { id: 'whisper-base', name: 'Whisper Base', type: 'stt', source: 'huggingface' }],
        ['silero-vad-v5', { id: 'silero-vad-v5', name: 'Silero VAD v5', type: 'vad', source: 'huggingface' }],
    ]);
    let selected: Record<string, string> = { stt: 'whisper-tiny' };

    return {
        getModelsByType: vi.fn((type: string) =>
            Array.from(models.values()).filter((m) => m.type === type)
        ),
        getSelected: vi.fn(() => ({ ...selected })),
        selectModel: vi.fn((type: string, modelId: string) => {
            const model = models.get(modelId);
            if (!model) {
                throw new AgenticError('NOT_FOUND', `Model ${modelId} not found`);
            }
            if (model.type !== type) {
                throw new AgenticError('VALIDATION_ERROR', `Model ${modelId} is not a ${type} model`);
            }
            selected[type] = modelId;
        }),
    };
}

describe('useArcaConfig — selectModel (M-001)', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    let mockModelRegistry: ReturnType<typeof createMockModelRegistry>;

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockModelRegistry = createMockModelRegistry();

        mockStore = {
            apiClient: null,
            logger: mockLogger,
            preferences: { language: 'en' },
            personalizationManager: null,
            modelRegistry: mockModelRegistry,
            modelRegistryVersion: 0,
            incrementModelRegistryVersion: vi.fn(() => {
                mockStore.modelRegistryVersion += 1;
            }),
            updatePreferences: vi.fn(),
            setPreferences: vi.fn(),
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('selectModel should trigger re-render with updated selected models', () => {
        const { result, rerender } = renderHook(() => useArcaConfig());

        expect(result.current.models.selected.stt).toBe('whisper-tiny');

        act(() => {
            result.current.selectModel('stt', 'whisper-base');
        });

        // After selectModel, the store version should have incremented
        // and the mock should return updated values on next render
        (useAgenticStore as any).mockReturnValue(mockStore);
        rerender();

        expect(result.current.models.selected.stt).toBe('whisper-base');
    });

    it('selectModel should update the models.selected object', () => {
        const { result, rerender } = renderHook(() => useArcaConfig());

        expect(result.current.models.selected).toEqual({ stt: 'whisper-tiny' });

        act(() => {
            result.current.selectModel('stt', 'whisper-base');
        });

        (useAgenticStore as any).mockReturnValue(mockStore);
        rerender();

        expect(result.current.models.selected).toEqual({ stt: 'whisper-base' });
    });

    it('selectModel should be a no-op when modelRegistry is null', () => {
        mockStore.modelRegistry = null;
        (useAgenticStore as any).mockReturnValue(mockStore);

        const { result } = renderHook(() => useArcaConfig());

        // Should not throw
        act(() => {
            result.current.selectModel('stt', 'whisper-base');
        });

        expect(mockStore.incrementModelRegistryVersion).not.toHaveBeenCalled();
    });

    it('selectModel should throw for non-existent model (via ModelRegistry)', () => {
        const { result } = renderHook(() => useArcaConfig());

        expect(() => {
            act(() => {
                result.current.selectModel('stt', 'non-existent-model');
            });
        }).toThrow('Model non-existent-model not found');
    });

    it('selectModel should throw for type mismatch (via ModelRegistry)', () => {
        const { result } = renderHook(() => useArcaConfig());

        expect(() => {
            act(() => {
                result.current.selectModel('stt', 'silero-vad-v5');
            });
        }).toThrow('Model silero-vad-v5 is not a stt model');
    });

    it('selectModel should call incrementModelRegistryVersion after successful selection', () => {
        const { result } = renderHook(() => useArcaConfig());

        act(() => {
            result.current.selectModel('stt', 'whisper-base');
        });

        expect(mockModelRegistry.selectModel).toHaveBeenCalledWith('stt', 'whisper-base');
        expect(mockStore.incrementModelRegistryVersion).toHaveBeenCalledTimes(1);
    });

    describe('models memo', () => {
        it('should return empty arrays when modelRegistry is null', () => {
            mockStore.modelRegistry = null;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useArcaConfig());

            expect(result.current.models).toEqual({
                stt: [],
                vad: [],
                ner: [],
                selected: {},
            });
        });

        it('should return models grouped by type', () => {
            const { result } = renderHook(() => useArcaConfig());

            expect(result.current.models.stt).toHaveLength(2);
            expect(result.current.models.vad).toHaveLength(1);
            expect(result.current.models.ner).toHaveLength(0);
            expect(result.current.models.selected).toEqual({ stt: 'whisper-tiny' });
        });
    });
});

describe('useArcaConfig — TASK-244 three-tier config', () => {
    let mockStore: any;
    let mockConfigManager: any;

    beforeEach(() => {
        mockConfigManager = {
            canUserEdit: vi.fn((path: string) => {
                const userPaths = ['audio.noiseSuppression', 'stt.language', 'audio.vadEnabled'];
                return userPaths.includes(path);
            }),
            setUserValue: vi.fn((path: string, _value: unknown) => {
                return mockConfigManager.canUserEdit(path);
            }),
            clearUserPreferences: vi.fn(),
            getResolved: vi.fn(() => ({ audio: { sampleRate: 16000 } })),
        };

        mockStore = {
            apiClient: null,
            logger: null,
            preferences: {},
            personalizationManager: null,
            modelRegistry: null,
            modelRegistryVersion: 0,
            incrementModelRegistryVersion: vi.fn(),
            updatePreferences: vi.fn(),
            setPreferences: vi.fn(),
            configManager: mockConfigManager,
            resolvedConfig: { audio: { sampleRate: 16000 }, stt: { language: 'en' } },
            configReady: true,
            tenantConfig: null,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should expose resolvedConfig from store', () => {
        const { result } = renderHook(() => useArcaConfig());
        expect(result.current.resolvedConfig).toEqual(mockStore.resolvedConfig);
    });

    it('should expose configReady from store', () => {
        const { result } = renderHook(() => useArcaConfig());
        expect(result.current.configReady).toBe(true);
    });

    it('isLocked should return false for user-editable fields', () => {
        const { result } = renderHook(() => useArcaConfig());
        expect(result.current.isLocked('audio.noiseSuppression')).toBe(false);
        expect(result.current.isLocked('stt.language')).toBe(false);
    });

    it('isLocked should return true for admin-only fields', () => {
        const { result } = renderHook(() => useArcaConfig());
        expect(result.current.isLocked('audio.sampleRate')).toBe(true);
        expect(result.current.isLocked('stt.provider')).toBe(true);
    });

    it('isLocked should return true when configManager is null', () => {
        mockStore.configManager = null;
        (useAgenticStore as any).mockReturnValue(mockStore);
        const { result } = renderHook(() => useArcaConfig());
        expect(result.current.isLocked('audio.noiseSuppression')).toBe(true);
    });

    it('setUserPreference should succeed for user-editable fields', () => {
        const { result } = renderHook(() => useArcaConfig());
        let success: boolean = false;
        act(() => {
            success = result.current.setUserPreference('stt.language', 'hi');
        });
        expect(success).toBe(true);
        expect(mockConfigManager.setUserValue).toHaveBeenCalledWith('stt.language', 'hi');
    });

    it('setUserPreference should fail for admin-only fields', () => {
        const { result } = renderHook(() => useArcaConfig());
        let success: boolean = true;
        act(() => {
            success = result.current.setUserPreference('audio.sampleRate', 44100);
        });
        expect(success).toBe(false);
    });

    it('setUserPreference should return false when configManager is null', () => {
        mockStore.configManager = null;
        (useAgenticStore as any).mockReturnValue(mockStore);
        const { result } = renderHook(() => useArcaConfig());
        let success: boolean = true;
        act(() => {
            success = result.current.setUserPreference('stt.language', 'hi');
        });
        expect(success).toBe(false);
    });

    it('resetUserPreferences should call configManager.clearUserPreferences', () => {
        const { result } = renderHook(() => useArcaConfig());
        act(() => {
            result.current.resetUserPreferences();
        });
        expect(mockConfigManager.clearUserPreferences).toHaveBeenCalledTimes(1);
    });

    it('resetUserPreferences should be no-op when configManager is null', () => {
        mockStore.configManager = null;
        (useAgenticStore as any).mockReturnValue(mockStore);
        const { result } = renderHook(() => useArcaConfig());
        act(() => {
            result.current.resetUserPreferences();
        });
        // Should not throw
    });

    it('configReady should reflect false when store says false', () => {
        mockStore.configReady = false;
        (useAgenticStore as any).mockReturnValue(mockStore);
        const { result } = renderHook(() => useArcaConfig());
        expect(result.current.configReady).toBe(false);
    });

    it('resolvedConfig should be null when store has no config', () => {
        mockStore.resolvedConfig = null;
        (useAgenticStore as any).mockReturnValue(mockStore);
        const { result } = renderHook(() => useArcaConfig());
        expect(result.current.resolvedConfig).toBeNull();
    });
});
