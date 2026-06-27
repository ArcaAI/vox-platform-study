/**
 * Shared surface props (TASK-372 §3.1.4): density + base + async-state contracts
 * reused by all three flagship components.
 */
import type * as React from 'react';

export type Density = 'comfortable' | 'compact';

export interface DensityProps {
  density?: Density;
}

export interface AsyncStateProps {
  isLoading?: boolean;
  error?: Error | null;
  emptyState?: React.ReactNode;
  errorState?: (error: Error) => React.ReactNode;
  loadingState?: React.ReactNode;
}

export interface BaseSurfaceProps extends DensityProps {
  className?: string;
}

/** Row/segment height tokens (px) per density — virtualization estimate defaults. */
export const DENSITY_ROW_HEIGHT: Record<Density, number> = {
  comfortable: 48,
  compact: 36,
};

/** Vertical item padding tokens (Tailwind class) per density. */
export const DENSITY_PADDING_Y: Record<Density, string> = {
  comfortable: 'py-3',
  compact: 'py-1.5',
};
