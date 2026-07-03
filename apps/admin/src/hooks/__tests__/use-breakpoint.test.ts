import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBreakpoint, useMediaQuery } from '../use-breakpoint';

/**
 * Controllable `matchMedia` mock. `widthMatches(query)` decides whether each
 * `(min-width: Npx)` query currently matches a simulated viewport width, and
 * exposes the registered `change` listeners so a test can simulate a resize.
 */
function installMatchMedia(width: number) {
  const listeners = new Set<() => void>();
  const matchesFor = (query: string): boolean => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    if (!m) return false;
    return width >= Number(m[1]);
  };
  const setWidth = (next: number) => {
    width = next;
    act(() => listeners.forEach((l) => l()));
  };
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() {
      return matchesFor(query);
    },
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    dispatchEvent: vi.fn(),
  }));
  return { setWidth };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMediaQuery', () => {
  it('returns the current matchMedia result for the query', () => {
    installMatchMedia(800);
    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(true);

    const { result: tooNarrow } = renderHook(() => useMediaQuery('(min-width: 1024px)'));
    expect(tooNarrow.current).toBe(false);
  });

  it('updates when the media query changes', () => {
    const mm = installMatchMedia(500);
    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(false);
    act(() => mm.setWidth(900));
    expect(result.current).toBe(true);
  });
});

describe('useBreakpoint', () => {
  it('resolves mobile below md (768)', () => {
    installMatchMedia(375);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toEqual({ breakpoint: 'mobile', isMobile: true, isTablet: false, isDesktop: false });
  });

  it('resolves tablet between md and lg (768–1023)', () => {
    installMatchMedia(800);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toEqual({ breakpoint: 'tablet', isMobile: false, isTablet: true, isDesktop: false });
  });

  it('resolves desktop at lg (1024) and up', () => {
    installMatchMedia(1440);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toEqual({ breakpoint: 'desktop', isMobile: false, isTablet: false, isDesktop: true });
  });

  it('reacts to a viewport resize across tiers', () => {
    const mm = installMatchMedia(375);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current.breakpoint).toBe('mobile');
    act(() => mm.setWidth(800));
    expect(result.current.breakpoint).toBe('tablet');
    act(() => mm.setWidth(1280));
    expect(result.current.breakpoint).toBe('desktop');
  });
});
