import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../use-theme';

/**
 * Regression cover for — "stale text colour survives
 * a theme change until the element repaints".
 *
 * The visual symptom itself (a frozen `color` interpolation) is a browser paint
 * behaviour and cannot be observed in happy-dom, which has no layout or
 * compositor. What CAN be pinned here are the two properties of the hook that
 * remove the trigger, and both were RED before the fix:
 *
 * 1. it ADOPTS the class the pre-paint bootstrap script left on `<html>`,
 * instead of re-deriving the theme and re-applying it after first paint;
 * 2. it flips the class with CSS transitions SUPPRESSED, so no colour
 * transition is ever started by a theme change.
 *
 * Note `documentElement.classList` — not a `matchMedia` mock — is the source of
 * truth in test 1: that is precisely the behaviour that changed.
*/

const SUPPRESSOR = /transition:\s*none/;

function hasTransitionSuppressor(): boolean {
  return [...document.head.querySelectorAll('style')].some((style) => SUPPRESSOR.test(style.textContent ?? ''));
}

/** Fake `matchMedia`; `dark` is what the OS reports. */
function stubMatchMedia(dark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: dark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

describe('useTheme', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    document.head.querySelectorAll('style').forEach((style) => style.remove());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove('dark');
  });

  it('adopts the theme class already applied to <html> before first paint', () => {
    // The bootstrap script in index.html saw a dark OS preference and applied
    // the class. A later OS flip to light must NOT retroactively undo it —
    // the hook's initial state is the DOM, not `matchMedia`.
    document.documentElement.classList.add('dark');
    stubMatchMedia(false);

    const { result } = renderHook(() => useTheme());

    expect(result.current[0]).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('falls back to the OS preference when no class was applied', () => {
    stubMatchMedia(true);

    const { result } = renderHook(() => useTheme());

    expect(result.current[0]).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('suppresses CSS transitions for the duration of a theme flip', () => {
    stubMatchMedia(false);

    // The style flush is the one moment the suppressed window is observable
    // synchronously (a MutationObserver would fire after the suppressor is
    // already gone). Sampling there pins the whole ordering:
    // suppress → flip the class → flush → unsuppress.
    const samples: { suppressed: boolean; dark: boolean }[] = [];
    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    vi.stubGlobal('getComputedStyle', (...args: Parameters<typeof window.getComputedStyle>) => {
      samples.push({ suppressed: hasTransitionSuppressor(), dark: document.documentElement.classList.contains('dark') });
      return originalGetComputedStyle(...args);
    });

    const { result } = renderHook(() => useTheme());
    act(() => result.current[1]());

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    // The dark class was committed while transitions were still off.
    expect(samples.some((sample) => sample.suppressed && sample.dark)).toBe(true);

    // …and the suppressor never outlives the flip: normal transitions (hover,
    // focus ring) must keep working afterwards.
    expect(hasTransitionSuppressor()).toBe(false);
  });
});
