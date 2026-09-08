'use client';

import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useStorageHealth } from '../api/hooks';
import type { StorageHealth } from '../api/types';

/** Shared between the tenant-scoped and "All tenants" (TASK-932) screen bodies. */
export const ENDPOINT_HINT = 'GET /storage/buckets';

function healthLabel(health: StorageHealth): string {
  if (health.status === 'not-configured') return 'Storage not configured';
  if (health.status === 'healthy' && health.connected) return health.isMinIO ? 'MinIO reachable' : 'Storage reachable';
  return health.isMinIO ? 'MinIO unreachable' : 'Storage unreachable';
}

function healthDotClass(health: StorageHealth): string {
  if (health.status === 'healthy' && health.connected) return 'bg-success';
  if (health.status === 'not-configured') return 'bg-warning';
  return 'bg-destructive';
}

/** Footer health verdict (frame 31): dot + probe result, from GET /storage/health. */
export function HealthStatus() {
  const { data, isPending, isError } = useStorageHealth();
  if (isPending) return <Skeleton className="h-4 w-32" />;
  const health: StorageHealth = isError ? { status: 'unhealthy', connected: false, isMinIO: false } : (data as StorageHealth);
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${healthDotClass(health)}`} />
      <span className="truncate">{healthLabel(health)}</span>
    </span>
  );
}
