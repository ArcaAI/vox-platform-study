'use client';

import { useQuery } from '@tanstack/react-query';
import { modelStoreKeys } from './keys';
import { listModelStoreBuckets, listModelStoreObjects } from './model-store-client';

export function useModelStoreBuckets() {
  return useQuery({
    queryKey: modelStoreKeys.buckets(),
    queryFn: listModelStoreBuckets,
  });
}

export function useModelStoreObjects(bucket: string | null, prefix: string) {
  return useQuery({
    queryKey: modelStoreKeys.objects(bucket ?? '', prefix),
    queryFn: () => listModelStoreObjects(bucket!, prefix),
    enabled: Boolean(bucket),
  });
}
