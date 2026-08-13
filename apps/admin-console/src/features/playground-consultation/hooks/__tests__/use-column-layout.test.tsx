/**
 * per-user resizable column layout for the scribe workspace.
 * The `@arcaai/vox` `useUserSettings` plane is mocked at the boundary; the
 * contract under test: load persisted sizes on mount (defaults on miss or
 * malformed value), debounce saves through `updateByKey` under the
 * `ui.consultation-playground/columns` namespace, and never throw when the
 * settings plane rejects (personalization is best-effort).
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  list: vi.fn(),
  updateByKey: vi.fn(),
}));

vi.mock('@arcaai/vox', () => ({
  useUserSettings: () => ({
    settings: [],
    isLoading: false,
    error: null,
    list: settings.list,
    updateByKey: settings.updateByKey,
    listForUser: vi.fn(),
    updateForUser: vi.fn(),
  }),
}));

import { DEFAULT_SCRIBE_SIZES, SCRIBE_LAYOUT_KEY, SCRIBE_LAYOUT_NAMESPACE, useColumnLayout } from '../use-column-layout';

function settingsRow(value: unknown) {
  return [{ id: 's-1', namespace: SCRIBE_LAYOUT_NAMESPACE, key: SCRIBE_LAYOUT_KEY, value }];
}

beforeEach(() => {
  vi.useFakeTimers();
  settings.list.mockResolvedValue([]);
  settings.updateByKey.mockResolvedValue({});
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  cleanup();
});

describe('useColumnLayout', () => {
  it('loads the persisted layout and reports ready', async () => {
    settings.list.mockResolvedValue(settingsRow(JSON.stringify({ v: 1, sizes: [30, 40, 30] })));

    const { result } = renderHook(() => useColumnLayout());
    expect(result.current.isReady).toBe(false);

    await act(async () => {});
    expect(result.current.isReady).toBe(true);
    expect(result.current.sizes).toEqual([30, 40, 30]);
  });

  it('falls back to defaults when no row exists', async () => {
    const { result } = renderHook(() => useColumnLayout());
    await act(async () => {});
    expect(result.current.isReady).toBe(true);
    expect(result.current.sizes).toEqual([...DEFAULT_SCRIBE_SIZES]);
  });

  it.each([
    ['malformed JSON', 'not-json'],
    ['wrong panel count', JSON.stringify({ v: 1, sizes: [50, 50] })],
    ['non-numeric sizes', JSON.stringify({ v: 1, sizes: ['a', 'b', 'c'] })],
    ['non-positive sizes', JSON.stringify({ v: 1, sizes: [0, 50, 50] })],
  ])('keeps defaults on %s', async (_label, value) => {
    settings.list.mockResolvedValue(settingsRow(value));

    const { result } = renderHook(() => useColumnLayout());
    await act(async () => {});
    expect(result.current.isReady).toBe(true);
    expect(result.current.sizes).toEqual([...DEFAULT_SCRIBE_SIZES]);
  });

  it('stays ready-with-defaults when the settings read rejects', async () => {
    settings.list.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useColumnLayout());
    await act(async () => {});
    expect(result.current.isReady).toBe(true);
    expect(result.current.sizes).toEqual([...DEFAULT_SCRIBE_SIZES]);
  });

  it('applies persist() locally at once and saves debounced under the scribe namespace', async () => {
    const { result } = renderHook(() => useColumnLayout());
    await act(async () => {});
    expect(result.current.isReady).toBe(true);

    act(() => result.current.persist([20, 45, 35]));
    expect(result.current.sizes).toEqual([20, 45, 35]);
    expect(settings.updateByKey).not.toHaveBeenCalled();

    // The debounced save resolves through a microtask — flush via async act.
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(settings.updateByKey).toHaveBeenCalledTimes(1);
    expect(settings.updateByKey).toHaveBeenCalledWith(SCRIBE_LAYOUT_NAMESPACE, SCRIBE_LAYOUT_KEY, JSON.stringify({ v: 1, sizes: [20, 45, 35] }));
  });

  it('collapses rapid resizes into one trailing save', async () => {
    const { result } = renderHook(() => useColumnLayout());
    await act(async () => {});
    expect(result.current.isReady).toBe(true);

    act(() => result.current.persist([25, 40, 35]));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => result.current.persist([26, 39, 35]));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => result.current.persist([28, 37, 35]));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    expect(settings.updateByKey).toHaveBeenCalledTimes(1);
    expect(settings.updateByKey).toHaveBeenCalledWith(SCRIBE_LAYOUT_NAMESPACE, SCRIBE_LAYOUT_KEY, JSON.stringify({ v: 1, sizes: [28, 37, 35] }));
  });

  it('ignores invalid sizes passed to persist()', async () => {
    const { result } = renderHook(() => useColumnLayout());
    await act(async () => {});
    expect(result.current.isReady).toBe(true);

    act(() => result.current.persist([50, 50]));
    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(result.current.sizes).toEqual([...DEFAULT_SCRIBE_SIZES]);
    expect(settings.updateByKey).not.toHaveBeenCalled();
  });

  it('swallows a rejected save (personalization is best-effort)', async () => {
    settings.updateByKey.mockRejectedValue(new Error('503'));

    const { result } = renderHook(() => useColumnLayout());
    await act(async () => {});
    expect(result.current.isReady).toBe(true);

    act(() => result.current.persist([22, 40, 38]));
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(result.current.sizes).toEqual([22, 40, 38]);
  });
});
