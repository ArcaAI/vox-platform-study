'use client';

import { IconInfoCircle } from '@tabler/icons-react';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { formatBytes, formatNumber, formatRelativeTime } from '@/shared/format';
import { useModelLifecycle } from '../api/hooks';
import type { AiModel, ModelServiceState } from '../api/types';
import {
  LM_STUDIO_RESTART_HINT,
  LIFECYCLE_META,
  LifecycleBadge,
  downloadBytesLabel,
  downloadPercent,
  needsLmStudioRestart,
} from './lifecycle-badge';

const SERVICE_STATE_LABELS: Record<ModelServiceState, string> = {
  loaded: 'Loaded',
  loading: 'Loading',
  unloading: 'Unloading',
  not_loaded: 'Not loaded',
  failed: 'Failed',
};

/**
 * "Status" section of the edit drawer (TASK-1019 OD-5): the one lifecycle word
 * plus the per-service evidence behind it — state, device, memory, in-flight
 * requests, requests/min and the recorded failure (code + message). It reads its
 * OWN live query (`useModelLifecycle`) so polling never advances the ETag the
 * edit form PATCHes with.
 */
export function ModelStatusSection({ model }: { model: AiModel }) {
  const query = useModelLifecycle(model.id);
  // The drawer already holds the row it opened from — show that while the live read is in flight.
  const lifecycle = query.data ?? model.lifecycle ?? null;

  return (
    <section aria-labelledby={`status-${model.id}`} className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id={`status-${model.id}`} className="text-sm font-medium">
          Status
        </h3>
        {lifecycle ? <LifecycleBadge status={lifecycle.status} /> : null}
      </div>

      {query.isPending && !lifecycle ? (
        <div role="status" className="flex flex-col gap-2" aria-label="Loading status">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : !lifecycle ? (
        <p className="text-muted-foreground text-xs">The gateway did not report a lifecycle for this model.</p>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            {LIFECYCLE_META[lifecycle.status].hint}
            {lifecycle.observedAt ? ` Observed ${formatRelativeTime(lifecycle.observedAt)}.` : ''}
          </p>

          {lifecycle.status === 'DOWNLOADING' && lifecycle.download ? (
            <div className="flex flex-col gap-1">
              <Progress
                value={downloadPercent(lifecycle.download) ?? undefined}
                aria-label={`Download progress for ${model.name}`}
                aria-valuetext={downloadPercent(lifecycle.download) === null ? 'In progress' : `${downloadPercent(lifecycle.download)}%`}
              />
              <span className="text-muted-foreground font-mono text-xs">{downloadBytesLabel(lifecycle.download)}</span>
            </div>
          ) : null}
          {lifecycle.download?.error ? (
            <p role="alert" className="text-destructive text-xs">
              {lifecycle.download.error}
            </p>
          ) : null}
          {lifecycle.unregister?.error ? (
            <p role="alert" className="text-destructive text-xs">
              Unregister: {lifecycle.unregister.error}
            </p>
          ) : null}
          {needsLmStudioRestart({ ...model, lifecycle }) ? (
            <p className="text-muted-foreground flex items-center gap-1 text-xs">
              <IconInfoCircle aria-hidden className="size-3.5 shrink-0" />
              {LM_STUDIO_RESTART_HINT}
            </p>
          ) : null}

          {lifecycle.services.length === 0 ? (
            <p className="text-muted-foreground text-xs">No serving engine reports this model.</p>
          ) : (
            <Table aria-label="Per-service status">
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead className="text-right">Memory</TableHead>
                  <TableHead className="text-right">In flight</TableHead>
                  <TableHead className="text-right">Req/min</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lifecycle.services.map((service) => (
                  <TableRow key={service.service}>
                    <TableCell className="font-mono text-xs">{service.service}</TableCell>
                    <TableCell>{SERVICE_STATE_LABELS[service.state] ?? service.state}</TableCell>
                    <TableCell className="font-mono text-xs">{service.device ?? '—'}</TableCell>
                    <TableCell className="text-right">{formatBytes(service.bytes)}</TableCell>
                    <TableCell className="text-right">{formatNumber(service.inFlight)}</TableCell>
                    <TableCell className="text-right">{formatNumber(service.requestsPerMin)}</TableCell>
                    <TableCell className="text-xs">
                      {service.error ? (
                        <span className="text-destructive">
                          <span className="font-mono">{service.error.code}</span>: {service.error.message}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </section>
  );
}
