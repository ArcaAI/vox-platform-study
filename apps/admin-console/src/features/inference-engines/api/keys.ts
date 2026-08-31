import type { InferenceEngineProvider } from './types';

/**
 * Query keys are namespaced per ENGINE, so the LM Studio screen and the vLLM
 * screen never share a cache entry and "Probe now" on one cannot invalidate the
 * other's (deliberately different engines, deliberately different probes).
 */
export const inferenceEngineKeys = {
  root: ['inference-engines'] as const,
  engine: (provider: InferenceEngineProvider) => [...inferenceEngineKeys.root, provider] as const,
  discovery: (provider: InferenceEngineProvider) => [...inferenceEngineKeys.engine(provider), 'discovery'] as const,
  connection: (provider: InferenceEngineProvider) => [...inferenceEngineKeys.engine(provider), 'connection'] as const,
  artifacts: (provider: InferenceEngineProvider, prefix: string) => [...inferenceEngineKeys.engine(provider), 'artifacts', prefix] as const,
};
