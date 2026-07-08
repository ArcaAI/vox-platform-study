import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useViewportTier } from '../use-viewport-tier';

/** Stub matchMedia so `(min-width: N)` matches when the viewport is >= N. */
function mockViewport(width: number) {
    vi.stubGlobal('matchMedia', (query: string) => {
        const min = /min-width:\s*(\d+)/.exec(query);
        return {
            matches: min ? width >= Number(min[1]) : false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
            onchange: null,
        } as MediaQueryList;
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('useViewportTier', () => {
    it('reports desktop at >= 1280px', () => {
        mockViewport(1440);
        const { result } = renderHook(() => useViewportTier());
        expect(result.current).toBe('desktop');
    });

    it('reports tablet in the 768–1279px band', () => {
        mockViewport(1024);
        const { result } = renderHook(() => useViewportTier());
        expect(result.current).toBe('tablet');
    });

    it('reports mobile below 768px', () => {
        mockViewport(500);
        const { result } = renderHook(() => useViewportTier());
        expect(result.current).toBe('mobile');
    });
});
