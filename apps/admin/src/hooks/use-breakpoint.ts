import * as React from 'react';

/**
 * Tailwind-aligned breakpoint signals for responsive admin surfaces (TASK-384).
 *
 * The shell, table→card switch and tabs→Select switch follow the approved
 * `07 · Responsive` design's three tiers:
 *  - **mobile**  `< md (768)`   — app-bar + drawer + card-list
 *  - **tablet**  `md..lg`       — icon-rail + condensed table
 *  - **desktop** `≥ lg (1024)`  — full sidebar + full table
 *
 * Most of the shell is handled with plain Tailwind `md:`/`lg:` variants; this
 * hook is only for the cases that need a runtime decision (the virtualized grid
 * can't be CSS-toggled into cards, and we don't want to mount both tab UIs).
 */
export const BREAKPOINTS = { md: 768, lg: 1024 } as const;

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

/** Subscribe to a CSS media query. SSR-safe (returns `false` until mounted). */
export function useMediaQuery(query: string): boolean {
    const getMatch = React.useCallback(
        () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
        [query],
    );

    const [matches, setMatches] = React.useState<boolean>(getMatch);

    React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mql = window.matchMedia(query);
        const onChange = () => setMatches(mql.matches);
        onChange();
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, [query]);

    return matches;
}

export interface BreakpointState {
    breakpoint: Breakpoint;
    isMobile: boolean;
    isTablet: boolean;
    isDesktop: boolean;
}

/** Resolve the active responsive tier from viewport width. */
export function useBreakpoint(): BreakpointState {
    const isTabletUp = useMediaQuery(`(min-width: ${BREAKPOINTS.md}px)`);
    const isDesktopUp = useMediaQuery(`(min-width: ${BREAKPOINTS.lg}px)`);

    const breakpoint: Breakpoint = isDesktopUp ? 'desktop' : isTabletUp ? 'tablet' : 'mobile';

    return {
        breakpoint,
        isMobile: !isTabletUp,
        isTablet: isTabletUp && !isDesktopUp,
        isDesktop: isDesktopUp,
    };
}
