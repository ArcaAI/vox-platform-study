'use client';

import type * as React from 'react';
import { formatDistanceToNow } from 'date-fns';

import { ItemList } from '@/components/collection/item-list';
import { StatusBadge, type StatusColorRole } from '@/components/shared/status-badge';
import type { AsyncStateProps, BaseSurfaceProps } from '@/lib/shared';

import { StatusDot } from './status-dot';

export type ModelStatus = 'loaded' | 'loading' | 'error' | 'unloaded';

export interface ModelInfo {
  id: string;
  name: string;
  status: ModelStatus;
  version?: string;
  /** Pre-formatted size string, e.g. "1.5 GB". */
  size?: string;
  /** Rendered as relative time via `date-fns formatDistanceToNow`. */
  updatedAt?: Date | string | number;
}

export interface ModelsListProps extends BaseSurfaceProps, AsyncStateProps {
  models: ModelInfo[];
  'aria-label'?: string;
}

const MODEL_META: Record<ModelStatus, { role: StatusColorRole; label: string; pulse?: boolean }> = {
  loaded: { role: 'success', label: 'Loaded' },
  loading: { role: 'info', label: 'Loading', pulse: true },
  error: { role: 'destructive', label: 'Error' },
  unloaded: { role: 'neutral', label: 'Unloaded' },
};

function relativeTime(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * Loaded-models list — a preset over the `ItemList`
 * foundation. Like `RunningTasksList` but each row adds a `StatusBadge`
 * (loaded/loading/error) plus size and `font-mono` version columns. The leading
 * `StatusDot` is decorative — the `StatusBadge` carries the textual status, so
 * status is never color-only. Loading/empty/error delegate to `ItemList`.
 */
export function ModelsList({
  models,
  density = 'comfortable',
  className,
  isLoading,
  error,
  emptyState,
  errorState,
  loadingState,
  ...props
}: ModelsListProps) {
  const ariaLabel = props['aria-label'] ?? 'Models';

  const renderRow = (model: ModelInfo): React.ReactNode => {
    const meta = MODEL_META[model.status] ?? MODEL_META.unloaded;
    return (
      <>
        <StatusDot colorRole={meta.role} pulse={meta.pulse} />
        <span className="min-w-0 flex-1 truncate font-medium">{model.name}</span>
        <span data-slot="model-id" className="font-mono text-xs text-muted-foreground">
          {model.id}
        </span>
        <StatusBadge label={meta.label} colorRole={meta.role} />
        {model.size ? (
          <span data-slot="model-size" className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {model.size}
          </span>
        ) : null}
        {model.version ? (
          <span data-slot="model-version" className="shrink-0 font-mono text-xs text-muted-foreground">
            {model.version}
          </span>
        ) : null}
        {model.updatedAt != null ? (
          <time data-slot="model-updated" className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {relativeTime(model.updatedAt)}
          </time>
        ) : null}
      </>
    );
  };

  return (
    <ItemList
      items={models}
      getItemId={(m) => m.id}
      renderRow={renderRow}
      density={density}
      className={className}
      isLoading={isLoading}
      error={error}
      emptyState={emptyState}
      errorState={errorState}
      loadingState={loadingState}
      aria-label={ariaLabel}
    />
  );
}
