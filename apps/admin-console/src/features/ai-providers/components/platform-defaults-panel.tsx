'use client';

import type { ReactNode } from 'react';
import { IconLockSquareRounded } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import type { UseQueryResult } from '@tanstack/react-query';
import { ErrorState } from '@/shared/state/error-state';
import type { PlatformDefaultConnection, PlatformDefaultResolution, PlatformDefaults, ProviderService } from '../api/types';
import { cloudProvidersFor, type ProviderMeta } from './provider-meta';

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

/**
 * The cascade's verdict, in a tenant's words. `inherited` is the one that
 * matters most and is the only one styled as "on": it is the row that serves
 * this tenant today when it brings nothing of its own.
 */
const RESOLUTION_LABEL: Record<PlatformDefaultResolution, { label: string; variant: BadgeVariant; detail: string }> = {
  inherited: { label: 'Serving you', variant: 'secondary', detail: 'You bring no key of your own, so this platform connection serves the provider for your tenant.' },
  overridden: { label: 'Your key wins', variant: 'default', detail: 'Your own connection is enabled and keyed; the platform default is not consulted.' },
  vetoed: { label: 'Blocked by you', variant: 'destructive', detail: 'Your own connection is disabled, which blocks this provider for your tenant — including the platform key.' },
  'not-entitled': { label: 'Not in your plan', variant: 'outline', detail: 'Your plan does not include the platform’s vendor accounts; only a connection you bring serves this provider.' },
  'not-configured': { label: 'Not configured', variant: 'outline', detail: 'The platform has no key for this provider; bring your own to use it.' },
  off: { label: 'Off', variant: 'outline', detail: 'The platform switched this connection off; it serves nobody. Bring your own key to use the provider.' },
};

/**
 * The ONE line a tenant card shows under "Use platform default": what actually
 * happens today when this tenant brings nothing (TASK-954). `null` when the
 * verdict is about the tenant's own row (it already says so on the card).
 */
export function platformDefaultHint(connection: PlatformDefaultConnection | undefined): string | null {
  if (!connection) return null;
  switch (connection.resolution) {
    case 'inherited':
      return 'The platform default serves this provider for you today.';
    case 'not-configured':
    case 'off':
    case 'not-entitled':
      return RESOLUTION_LABEL[connection.resolution].detail;
    default:
      return null;
  }
}

/** The non-secret half of a platform row worth showing: where it points. */
function endpointOf(connection: PlatformDefaultConnection): string {
  return connection.baseUrl ?? connection.region ?? connection.deploymentName ?? '—';
}

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

/**
 * THE PLATFORM FALLBACK, READ-ONLY (TASK-954).
 *
 * A tenant admin sees and configures its OWN connections on the cards below
 * this panel, and sees here what the platform serves when it brings nothing —
 * the owner's rule for the tenant tier. The panel is read-only by construction:
 * the route behind it (`GET admin/providers/:service/platform-defaults`) is the
 * only tenant-reachable projection of the SYSTEM tier, it is masked (`hasKey`,
 * never the key), and nothing on the tenant tier writes a SYSTEM row.
 *
 * `providers` (the card metadata) supplies the human label; the row set comes
 * from the gateway, one per cloud provider of the service. The TAB owns the
 * read (`usePlatformDefaults`) and hands the same result to this panel and to
 * every card's hint, so one request answers both.
 */
export function PlatformDefaultsPanel({ service, query }: { service: ProviderService; query: UseQueryResult<PlatformDefaults> }) {
  const providers: readonly ProviderMeta[] = cloudProvidersFor(service);
  const headingId = `platform-defaults-${service}`;

  let body: ReactNode;
  if (query.isPending) {
    body = <PanelSkeleton />;
  } else if (query.error || !query.data) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else {
    const byProvider = new Map(query.data.connections.map((connection) => [connection.provider, connection]));
    body = (
      <div className="flex flex-col gap-2">
        {!query.data.entitled ? (
          <p className="text-warning-strong text-xs" role="note">
            Your plan does not include the platform’s vendor accounts: only connections you bring serve these providers.
          </p>
        ) : null}
        <Table aria-label={`Platform defaults for ${service}`}>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>For your tenant</TableHead>
              <TableHead>Platform key</TableHead>
              <TableHead>Endpoint / region</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.map((meta) => {
              const connection = byProvider.get(meta.id);
              const verdict = connection ? RESOLUTION_LABEL[connection.resolution] : RESOLUTION_LABEL['not-configured'];
              return (
                <TableRow key={meta.id}>
                  <TableCell className="font-medium">{meta.label}</TableCell>
                  <TableCell>
                    <Badge variant={verdict.variant} title={verdict.detail}>
                      {verdict.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{connection?.hasKey ? 'configured' : 'none'}</TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs" title={connection ? endpointOf(connection) : undefined}>
                    {connection ? endpointOf(connection) : '—'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-sm font-medium">
          Platform defaults
        </h3>
        <Badge variant="outline" className="gap-1">
          <IconLockSquareRounded aria-hidden className="size-3" />
          read-only
        </Badge>
      </div>
      <p className="text-muted-foreground text-xs">
        What the platform serves when you bring no key of your own. Managed by the platform; a connection you configure below wins outright, and
        disabling one blocks the provider for your tenant entirely.
      </p>
      {body}
    </section>
  );
}
