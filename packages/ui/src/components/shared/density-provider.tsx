'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Density } from '@/lib/shared/surface';

const DensityContext = createContext<Density | undefined>(undefined);

export interface DensityProviderProps {
  density: Density;
  children: ReactNode;
}

/** Provides a default `Density` to descendant surfaces. */
export function DensityProvider({ density, children }: DensityProviderProps) {
  return <DensityContext.Provider value={density}>{children}</DensityContext.Provider>;
}

/**
 * Resolve the effective density: explicit `override` prop wins, then the nearest
 * `DensityProvider`, then `'comfortable'`.
 */
export function useDensity(override?: Density): Density {
  const ctx = useContext(DensityContext);
  return override ?? ctx ?? 'comfortable';
}
