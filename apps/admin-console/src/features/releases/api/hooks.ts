'use client';

import { useQuery } from '@tanstack/react-query';

import type { Paginated } from '@/shared/api';

import { getCurrentReleases, getServiceReleaseHistory, listServiceReleases } from './client';
import { releaseKeys } from './keys';
import type { CurrentService, Environment, ServiceRelease, ServiceReleaseListParams } from './types';

export function useCurrentReleases(environment: Environment) {
  return useQuery<CurrentService[]>({
    queryKey: releaseKeys.current(environment),
    queryFn: () => getCurrentReleases(environment),
  });
}

export function useServiceReleases(params?: ServiceReleaseListParams) {
  return useQuery<Paginated<ServiceRelease>>({
    queryKey: releaseKeys.list(params),
    queryFn: () => listServiceReleases(params),
  });
}

export function useServiceReleaseHistory(serviceName: string | null) {
  return useQuery<ServiceRelease[]>({
    queryKey: releaseKeys.history(serviceName ?? ''),
    queryFn: () => getServiceReleaseHistory(serviceName ?? ''),
    enabled: serviceName !== null,
  });
}
