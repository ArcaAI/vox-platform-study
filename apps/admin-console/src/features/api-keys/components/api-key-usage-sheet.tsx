'use client';

import type { ReactNode } from 'react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useApiKeyUsage } from '../api/hooks';
import type { ApiKey } from '../api/types';
import { KeyStatusBadge } from './key-status-badge';

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function UsageBody({ apiKey }: { apiKey: ApiKey }) {
  const { data: usage, isPending, error, refetch } = useApiKeyUsage(apiKey.id);

  if (isPending) {
    return (
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex flex-col gap-1">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    );
  }
  if (error || !usage) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
      <MetaItem label="Total calls">
        <span className="tabular-nums">{formatNumber(usage.totalCalls)}</span>
      </MetaItem>
      <MetaItem label="Rate limit">
        <span className="tabular-nums">{formatNumber(usage.rateLimit)}</span>
      </MetaItem>
      <MetaItem label="Last used">{usage.lastUsedAt ? formatRelativeTime(usage.lastUsedAt) : 'Never'}</MetaItem>
      <MetaItem label="Status">
        <KeyStatusBadge apiKey={apiKey} />
      </MetaItem>
      <MetaItem label="Prefix">
        <span className="font-mono text-xs">{apiKey.keyPrefix}&hellip;</span>
      </MetaItem>
      <MetaItem label="Created">{formatDateTime(apiKey.createdAt)}</MetaItem>
      <MetaItem label="Expires">{apiKey.expiresAt ? formatDateTime(apiKey.expiresAt) : 'Never'}</MetaItem>
      <MetaItem label="Scopes">
        <span className="flex flex-wrap gap-1">
          {(apiKey.scopes ?? []).map((scope) => (
            <Badge key={scope} variant="outline" className="font-mono text-2xs">
              {scope}
            </Badge>
          ))}
        </span>
      </MetaItem>
    </dl>
  );
}

/** Usage drawer (frame 23 row action): GET /admin/api-keys/:id/usage stats. */
export function ApiKeyUsageSheet({ apiKey, onOpenChange }: { apiKey: ApiKey | null; onOpenChange: (open: boolean) => void }) {
  return (
    <DetailDrawer
      open={apiKey !== null}
      onOpenChange={onOpenChange}
      title="Key usage"
      meta={
        <span>
          <span className="font-mono">{apiKey?.keyName}</span> &mdash; call volume from the auth logs.
        </span>
      }
    >
      {apiKey ? <UsageBody key={apiKey.id} apiKey={apiKey} /> : null}
    </DetailDrawer>
  );
}
