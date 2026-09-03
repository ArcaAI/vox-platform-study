'use client';

import { useEffect, useState } from 'react';

/**
 * Responsive tiers (redesign build spec: Desktop >= 1280 (full multi-pane),
 * Tablet 768–1279 (sidebar → icon rail, 3-pane → 2-pane), Mobile < 768 (single
 * column, drawers → full-screen sheets). Backed by `matchMedia` and SSR-safe —
 * it defaults to `desktop` on the server / before hydration (the app is
 * desktop-first) and resolves the real tier on mount.
 */
export type ViewportTier = 'desktop' | 'tablet' | 'mobile';

export const TABLET_MIN_PX = 768;
export const DESKTOP_MIN_PX = 1280;

function computeTier(): ViewportTier {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'desktop';
  if (window.matchMedia(`(min-width: ${DESKTOP_MIN_PX}px)`).matches) return 'desktop';
  if (window.matchMedia(`(min-width: ${TABLET_MIN_PX}px)`).matches) return 'tablet';
  return 'mobile';
}

export function useViewportTier(): ViewportTier {
  const [tier, setTier] = useState<ViewportTier>(computeTier);

  useEffect(() => {
    const desktop = window.matchMedia(`(min-width: ${DESKTOP_MIN_PX}px)`);
    const tablet = window.matchMedia(`(min-width: ${TABLET_MIN_PX}px)`);
    const update = () => setTier(desktop.matches ? 'desktop' : tablet.matches ? 'tablet' : 'mobile');
    update();
    desktop.addEventListener('change', update);
    tablet.addEventListener('change', update);
    return () => {
      desktop.removeEventListener('change', update);
      tablet.removeEventListener('change', update);
    };
  }, []);

  return tier;
}
