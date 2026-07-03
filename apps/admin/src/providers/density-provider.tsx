import { DensityProvider } from '@arcaai/ui/components/shared';
import type { Density } from '@arcaai/ui/lib/shared';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { STORAGE_KEYS } from '@/lib/constants';

interface AppDensityValue {
  density: Density;
  setDensity: (density: Density) => void;
  toggle: () => void;
}

const AppDensityContext = createContext<AppDensityValue | undefined>(undefined);

function readStored(): Density {
  if (typeof window === 'undefined') return 'comfortable';
  return window.localStorage.getItem(STORAGE_KEYS.DENSITY) === 'compact' ? 'compact' : 'comfortable';
}

/**
 * App-level density state (persisted) wrapping the `@arcaai/ui` `DensityProvider`
 * so every consumed surface inherits the operator's chosen density (TASK-371).
 */
export function AppDensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensityState] = useState<Density>(readStored);

  const value = useMemo<AppDensityValue>(
    () => ({
      density,
      setDensity: (next) => {
        window.localStorage.setItem(STORAGE_KEYS.DENSITY, next);
        setDensityState(next);
      },
      toggle: () => {
        const next = density === 'compact' ? 'comfortable' : 'compact';
        window.localStorage.setItem(STORAGE_KEYS.DENSITY, next);
        setDensityState(next);
      },
    }),
    [density],
  );

  return (
    <AppDensityContext.Provider value={value}>
      <DensityProvider density={density}>{children}</DensityProvider>
    </AppDensityContext.Provider>
  );
}

export function useAppDensity(): AppDensityValue {
  const ctx = useContext(AppDensityContext);
  if (!ctx) throw new Error('useAppDensity must be used within AppDensityProvider');
  return ctx;
}
