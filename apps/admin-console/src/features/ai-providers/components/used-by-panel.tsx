'use client';

import { useMemo } from 'react';
import { IconBinaryTree2 } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { GatewayError } from '@/shared/api';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useProviderConnections, useRoutingBindings } from '../api/hooks';
import { connectionSlugOf, type ProviderConnection } from '../api/types';
import type { ResolvedProviderScope } from './use-provider-scope';

/**
 * TASK-958 — connection id → the name this tier gave it.
 *
 * Built from the three capabilities multiplicity applies to (D-9:
 * `llm | stt | tts`). Elsewhere a provider has exactly one connection, so its
 * id is not ambiguous and the short id below is answer enough. These reads
 * share the list cache the credential tabs already fill, and they run only when
 * a binding actually carries an id.
 */
function useConnectionNames(tenantId: string, enabled: boolean): Map<string, string> {
  const llm = useProviderConnections('llm', tenantId, enabled);
  const stt = useProviderConnections('stt', tenantId, enabled);
  const tts = useProviderConnections('tts', tenantId, enabled);

  return useMemo(() => {
    const rows: ProviderConnection[] = [llm.data, stt.data, tts.data].flatMap((list) => (Array.isArray(list) ? list : []));
    const names = new Map<string, string>();
    for (const row of rows) {
      if (row.id) names.set(row.id, row.name?.trim() || connectionSlugOf(row));
    }
    return names;
  }, [llm.data, stt.data, tts.data]);
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" aria-hidden>
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * "Used by" — the answer to "what breaks if I disable this?".
 *
 * TASK-862 ships the ROUTING half: every provider configuration
 * (`AiRoutingPolicy` row) the selected tier owns, with its task key and whether
 * it is the elected default. Agents (TASK-863) and workflow nodes (TASK-864)
 * join this panel after they land — their FK reverse lookups do not exist yet,
 * so the panel says so rather than pretending the list is complete.
 *
 * The read is SUPER_ADMIN-only on the gateway (imperative 403 for a tenant
 * admin). A 403 is rendered as "managed by the platform", not as an error:
 * it is a real answer about who may see the platform's routing table.
 */
export function UsedByPanel({ scope }: { scope: ResolvedProviderScope }) {
  const bindings = useRoutingBindings(scope.tenantId, !scope.isLoading);
  // Which CONNECTION a bound configuration spends — the question a tenant with
  // two accounts of one vendor cannot answer from the provider name (D-7).
  const hasConnectionBindings = (bindings.data ?? []).some((row) => row.providerConnectionId !== null);
  const connectionNames = useConnectionNames(scope.tenantId, !scope.isLoading && hasConnectionBindings);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="used-by">
      <div>
        <h2 id="used-by" className="text-sm font-medium">
          Used by
        </h2>
        <p className="text-muted-foreground text-xs">
          Task configurations bound to a provider in this tier. Agents and workflow nodes appear here once TASK-863 / TASK-864 land.
        </p>
      </div>
      {bindings.isPending ? (
        <TableSkeleton />
      ) : bindings.error instanceof GatewayError && bindings.error.status === 403 ? (
        <EmptyState icon={IconBinaryTree2} title="Managed by the platform" description="Routing configurations are administered by platform super admins; your provider connections above still apply to every task that selects them." />
      ) : bindings.error ? (
        <ErrorState error={bindings.error} onRetry={() => void bindings.refetch()} />
      ) : (bindings.data?.length ?? 0) === 0 ? (
        <EmptyState icon={IconBinaryTree2} title="No task bindings in this tier" description="Nothing in this tier selects a provider yet — every task falls through to the platform default." />
      ) : (
        <Table aria-label="Task configurations bound to a provider">
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Configuration</TableHead>
              <TableHead>Connection</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...(bindings.data ?? [])]
              .sort((a, b) => a.taskKey.localeCompare(b.taskKey) || Number(b.isDefault) - Number(a.isDefault) || a.priority - b.priority)
              .map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.taskKey}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {row.displayName ?? row.id}
                      {row.isDefault ? <Badge variant="default">default</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    {row.providerConnectionId === null ? (
                      <Badge variant="outline">platform-served</Badge>
                    ) : (
                      // An id that resolves to no listed connection still tells
                      // two accounts apart, so it is shortened rather than
                      // dropped.
                      <span className="font-mono text-xs">{connectionNames.get(row.providerConnectionId) ?? row.providerConnectionId.slice(0, 8)}</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.modelRef ?? row.modelId ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={row.enabled ? 'secondary' : 'outline'}>
                      {row.status.toLowerCase()}
                      {row.enabled ? '' : ' · off'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
