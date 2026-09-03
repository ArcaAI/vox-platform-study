'use client';

import { RefreshCw } from 'lucide-react';

import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { Skeleton } from '@/components/shadcn/skeleton';
import { StatusBadge, type StatusColorRole } from '@/components/shared/status-badge';
import type { Density } from '@/lib/shared';
import { cn } from '@/lib/utils';

import { StatusDot } from './status-dot';

export type ServiceStatus = 'healthy' | 'degraded' | 'unhealthy' | 'checking' | 'unknown';

export interface ServiceStatusItemProps {
  /** `useHealthCheck().services[k].service`. */
  name: string;
  status: ServiceStatus;
  /** P95 latency. Not in `useMonitoring`/`useHealthCheck` today — hidden when absent (PHASE-2-PLAN Q3). */
  p95Ms?: number;
  /** `useMonitoring().uptime[].uptimeSeconds`. */
  uptimeSeconds?: number;
  version?: string;
  error?: string;
  density?: Density;
  className?: string;
}

const STATUS_META: Record<ServiceStatus, { role: StatusColorRole; label: string; pulse?: boolean }> = {
  healthy: { role: 'success', label: 'Healthy' },
  degraded: { role: 'warning', label: 'Degraded' },
  unhealthy: { role: 'destructive', label: 'Unhealthy' },
  checking: { role: 'info', label: 'Checking', pulse: true },
  unknown: { role: 'neutral', label: 'Unknown' },
};

/** Worst-first precedence for the collapsed summary chip. */
const STATUS_PRECEDENCE: ServiceStatus[] = ['unhealthy', 'degraded', 'checking', 'unknown', 'healthy'];

function formatUptimeShort(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * One service row: dot + name + status badge, plus optional P95 / uptime / version
 * cells (each hidden when its datum is absent). Status is never color-only — the dot
 * is decorative and the `StatusBadge` carries the text label.
 */
export function ServiceStatusItem({
  name,
  status,
  p95Ms,
  uptimeSeconds,
  version,
  error,
  density = 'comfortable',
  className,
}: ServiceStatusItemProps) {
  const meta = STATUS_META[status] ?? STATUS_META.unknown;
  return (
    <div
      data-slot="service-status-item"
      data-status={status}
      className={cn('flex items-center gap-2', density === 'compact' ? 'text-xs' : 'text-sm', className)}
    >
      <StatusDot colorRole={meta.role} pulse={meta.pulse} />
      <span className="font-medium">{name}</span>
      <StatusBadge label={meta.label} colorRole={meta.role} />
      {p95Ms != null ? (
        <span data-slot="service-status-p95" className="tabular-nums text-muted-foreground">
          {p95Ms} ms
        </span>
      ) : null}
      {uptimeSeconds != null ? (
        <span data-slot="service-status-uptime" className="tabular-nums text-muted-foreground">
          {formatUptimeShort(uptimeSeconds)}
        </span>
      ) : null}
      {version ? (
        <span data-slot="service-status-version" className="font-mono text-xs text-muted-foreground">
          {version}
        </span>
      ) : null}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export interface ServiceStatusBarProps {
  services: ServiceStatusItemProps[];
  activeSessions?: number;
  processingJobs?: number;
  env?: string;
  onRefresh?: () => void;
  isLoading?: boolean;
  /** Pin to the bottom of the viewport as a footer bar. */
  fixed?: boolean;
  className?: string;
}

/**
 * Footer service-health strip (PHASE-2-PLAN A polite `role="status"` live
 * region listing every service (`ServiceStatusItem`) with session/job counts, an
 * environment badge and a ≥44px refresh button. On narrow widths it collapses to a
 * single "N/M healthy" summary chip that expands the full list in a `Popover`.
 */
export function ServiceStatusBar({ services, activeSessions, processingJobs, env, onRefresh, isLoading, fixed, className }: ServiceStatusBarProps) {
  const containerClass = cn('flex items-center gap-3 bg-card px-4 py-2 text-sm', fixed && 'sticky inset-x-0 bottom-0 z-40 border-t', className);

  if (isLoading) {
    return (
      <div data-slot="service-status-bar" role="status" aria-live="polite" aria-label="Loading service status" className={containerClass}>
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="ml-auto h-4 w-40" />
      </div>
    );
  }

  const healthy = services.filter((s) => s.status === 'healthy').length;
  const total = services.length;
  const worst = STATUS_PRECEDENCE.find((st) => services.some((s) => s.status === st)) ?? 'healthy';
  const summaryRole = STATUS_META[worst].role;

  return (
    <div data-slot="service-status-bar" role="status" aria-live="polite" className={containerClass}>
      {/* Desktop: the full per-service list. */}
      <div data-slot="service-status-list" className="hidden flex-wrap items-center gap-x-4 gap-y-1 md:flex">
        {services.map((service) => (
          <ServiceStatusItem key={service.name} {...service} />
        ))}
      </div>

      {/* Tablet/mobile: collapse to a summary chip that expands the list in a popover. */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-slot="service-status-summary"
            className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          >
            <StatusDot colorRole={summaryRole} />
            <span className="tabular-nums">
              {healthy}/{total} healthy
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-auto flex-col gap-2">
          {services.map((service) => (
            <ServiceStatusItem key={service.name} {...service} />
          ))}
        </PopoverContent>
      </Popover>

      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {activeSessions != null ? (
          <span className="tabular-nums">
            {activeSessions} active session{activeSessions === 1 ? '' : 's'}
          </span>
        ) : null}
        {processingJobs != null ? <span className="tabular-nums">{processingJobs} processing</span> : null}
        {env ? <Badge variant="secondary">{env}</Badge> : null}
        {onRefresh ? (
          <Button variant="ghost" size="sm" onClick={onRefresh} className="min-h-11 min-w-11 gap-1.5">
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        ) : null}
      </div>
    </div>
  );
}
