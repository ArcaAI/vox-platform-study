import type { Environment } from './types';

export const releaseKeys = {
  root: ['service-releases'] as const,
  current: (environment: Environment) => ['service-releases', 'current', environment] as const,
  list: (params?: Record<string, unknown>) => ['service-releases', 'list', params ?? {}] as const,
  history: (serviceName: string) => ['service-releases', 'history', serviceName] as const,
};
