'use client';

/**
 * @arcaai/vox/compat - ArcaCompatProvider
 *
 * Convenience wrapper so a migrating v1 app adds ONE provider taking its
 * familiar `SDK_CONFIG_OPTIONS` object, instead of hand-building an
 * `AgenticConfig`. It maps the v1 config and renders the v2
 * `<AgenticProvider>`.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { AgenticProvider } from '../providers';
import { mapV1ConfigToAgenticConfig } from './config-adapter';
import type { V1SdkConfig } from './types';

export interface ArcaCompatProviderProps {
  /** v1 `SDK_CONFIG_OPTIONS`. Its `credentials.apiKey` is REQUIRED. */
  options: V1SdkConfig;
  children: ReactNode;
}

/**
 * Compat-only feature flags. These have no v1 ancestor and
 * are NOT part of the v2 `AgenticConfig` — they only matter to compat hooks,
 * so they ride a small compat-local context instead of widening the shared
 * `AgenticConfig`/`AudioPluginConfig` types.
 */
interface CompatFeatureFlags {
  /** See `V1SdkConfig.enableProviderSwitch`. */
  enableProviderSwitch: boolean;
}

const DEFAULT_COMPAT_FEATURE_FLAGS: CompatFeatureFlags = { enableProviderSwitch: false };

const CompatFeatureFlagsContext = createContext<CompatFeatureFlags>(DEFAULT_COMPAT_FEATURE_FLAGS);

/**
 * @internal Consumed by `useArcaSttProvider` to learn whether the app opted
 * into the bidirectional provider-switch shim. Not part of the public compat
 * surface (not exported from the `compat` barrel).
 */
export function useCompatFeatureFlags(): CompatFeatureFlags {
  return useContext(CompatFeatureFlagsContext);
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
  const flags: CompatFeatureFlags = { enableProviderSwitch: options.enableProviderSwitch === true };
  return (
    <AgenticProvider config={config}>
      <CompatFeatureFlagsContext.Provider value={flags}>{children}</CompatFeatureFlagsContext.Provider>
    </AgenticProvider>
  );
}
