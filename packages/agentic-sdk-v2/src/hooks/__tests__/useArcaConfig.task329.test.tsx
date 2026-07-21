/**
 * useArcaConfig task-aware model selection.
 *
 * Adds `selectSttTask(task)` (delegates to the ModelRegistry + busts the
 * model-registry memo) and surfaces the persisted task via
 * `models.selected.sttTask`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaConfig } from '../useArcaConfig';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return {
    ...actual,
    useAgenticStore: vi.fn(),
  };
});

describe('useArcaConfig — TASK-329 task-aware selection', () => {
  let mockStore: any;
  let mockModelRegistry: any;
  const incrementModelRegistryVersion = vi.fn();

  beforeEach(() => {
    mockModelRegistry = {
      getModelsByType: vi.fn(() => []),
      getSelected: vi.fn().mockReturnValue({ stt: 'whisper-small', sttTask: 'translate' }),
      selectModel: vi.fn(),
      selectSttTask: vi.fn(),
    };

    mockStore = {
      preferences: {},
      personalizationManager: null,
      modelRegistry: mockModelRegistry,
      logger: createMockLogger(),
      configReady: true,
      updatePreferences: vi.fn(),
      setPreferences: vi.fn(),
      incrementModelRegistryVersion,
    };

    (useAgenticStore as any).mockImplementation((selector: any) => selector(mockStore));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the persisted sttTask via models.selected', () => {
    const { result } = renderHook(() => useArcaConfig());
    expect(result.current.models.selected.sttTask).toBe('translate');
  });

  it('selectSttTask delegates to the registry and busts the model-registry memo', () => {
    const { result } = renderHook(() => useArcaConfig());

    act(() => {
      result.current.selectSttTask('translate');
    });

    expect(mockModelRegistry.selectSttTask).toHaveBeenCalledWith('translate');
    expect(incrementModelRegistryVersion).toHaveBeenCalled();
  });

  it('does nothing when the registry is not available', () => {
    mockStore.modelRegistry = null;
    (useAgenticStore as any).mockImplementation((selector: any) => selector(mockStore));

    const { result } = renderHook(() => useArcaConfig());

    act(() => {
      result.current.selectSttTask('translate');
    });

    // should not throw
    expect(incrementModelRegistryVersion).not.toHaveBeenCalled();
  });
});
