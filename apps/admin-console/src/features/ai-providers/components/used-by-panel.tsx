'use client';

import { IconBinaryTree2 } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { GatewayError } from '@/shared/api';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useRoutingBindings } from '../api/hooks';
import type { ResolvedProviderScope } from './use-provider-scope';

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
                      {row.providerConnectionId === null ? <Badge variant="outline">platform-served</Badge> : null}
                    </span>
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
