'use client';

/**
 * @arcaai/vox/compat - ArcaCompatProvider
 *
 * Convenience wrapper so a migrating v1 app adds ONE provider taking its
 * familiar `SDK_CONFIG_OPTIONS` object, instead of hand-building an
 * `AgenticConfig`. It maps the v1 config (TASK-560 §5.1) and renders the v2
 * `<AgenticProvider>`.
 */

import type { ReactNode } from 'react';
import { AgenticProvider } from '../providers';
import { mapV1ConfigToAgenticConfig } from './config-adapter';
import type { V1SdkConfig } from './types';

export interface ArcaCompatProviderProps {
  /** v1 `SDK_CONFIG_OPTIONS`. Its `credentials.apiKey` is REQUIRED. */
  options: V1SdkConfig;
  children: ReactNode;
}

/**
 * Drop-in provider for v1 apps.
 *
 * @example
 * ```tsx
 * <ArcaCompatProvider options={SDK_CONFIG_OPTIONS}>
 *   <App />
 * </ArcaCompatProvider>
 * ```
 */
export function ArcaCompatProvider({ options, children }: ArcaCompatProviderProps) {
  const config = mapV1ConfigToAgenticConfig(options);
  return <AgenticProvider config={config}>{children}</AgenticProvider>;
}
