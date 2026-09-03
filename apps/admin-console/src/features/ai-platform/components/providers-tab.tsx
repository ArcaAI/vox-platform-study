'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { IconAdjustments, IconExternalLink, IconPlugConnected, IconStar, IconStarFilled } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect } from '@arcaai/ui/components/shadcn/native-select';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { GatewayError } from '@/shared/api';
import { RequirePermission } from '@/shared/auth/require-permission';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { AI_TASK_KEYS } from '@/shared/catalog/ai-task-keys';
import { useRoutingPolicies, useSetRoutingPolicyDefault } from '../api/hooks';
import { useRuntimeProfileSummary } from '../api/runtime-profile-client';
import type { AiRoutingPolicy } from '../api/types';
import { ProviderConnectionsSection } from './provider-connections-section';
import type { ResolvedAiPlatformScope } from './use-ai-platform-scope';

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" aria-hidden>
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * The elect-default control.
 *
 * `If-Match` carries the row's OCC version, which the LIST response supplies as
 * `version` — the same number the gateway would have stamped as the ETag on a
 * single GET. Electing is atomic on the server (unset + set in one transaction,
 * behind a partial unique index), so this never has to sequence two writes and
 * two administrators racing cannot both win: the loser gets 412 and refetches.
 */
function ElectDefaultButton({ policy, scope }: { policy: AiRoutingPolicy; scope: ResolvedAiPlatformScope }) {
  const elect = useSetRoutingPolicyDefault(scope.tenantId);
  const label = `${policy.displayName ?? policy.modelRef ?? policy.id}`;

  if (policy.isDefault) {
    return (
      <Badge variant="default" className="gap-1">
        <IconStarFilled aria-hidden className="size-3" />
        Default
      </Badge>
    );
  }

  const blockedReason = !policy.enabled ? 'This configuration is disabled and cannot be elected.' : null;

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={blockedReason !== null || elect.isPending}
      aria-label={blockedReason ? `Make default — unavailable. ${blockedReason}` : `Make ${label} the default for ${policy.taskKey}`}
      title={blockedReason ?? undefined}
      onClick={() =>
        elect.mutate(
          { id: policy.id, etag: `"${policy.version}"` },
          {
            onSuccess: () => toast.success(`${label} is now the default for ${policy.taskKey}.`),
            onError: (error) =>
              toast.error(
                error instanceof GatewayError && error.status === 412
                  ? 'Someone else changed this configuration. Reload and try again.'
                  : error instanceof Error
                    ? error.message
                    : 'Could not elect this configuration.',
              ),
          },
        )
      }
    >
      <IconStar aria-hidden />
      Make default
    </Button>
  );
}

/**
 * PROVIDERS — every provider configuration, filterable by task, with the
 * elected-default badge per task.
 *
 * Three things live here because they are one job (onboarding a provider), even
 * though they are three backend resources:
 *
 *  1. **Connections** — `AiProviderConnection`: where a provider lives and how
 *     we authenticate to it. The one authoritative credential editor.
 *  2. **Configurations** — `AiRoutingPolicy` rows: which connection + model
 *     serves which task, and which of them is elected.
 *  3. **Runtime tuning** — `AiRuntimeProfile`: the hyperparameter/capacity plane
 * that used to be a peer rail entry. It tunes a
 *     (provider, model) pair, so it belongs beside the configuration that names
 *     that pair, not next to it in the rail.
 */
export function ProvidersTab({ scope }: { scope: ResolvedAiPlatformScope }) {
  const [taskFilter, setTaskFilter] = useState('');
  const policies = useRoutingPolicies(scope.tenantId, taskFilter || undefined, !scope.isLoading);
  const runtimeProfiles = useRuntimeProfileSummary(!scope.isLoading);

  const grouped = useMemo(() => {
    const byTask = new Map<string, AiRoutingPolicy[]>();
    for (const policy of policies.data ?? []) {
      byTask.set(policy.taskKey, [...(byTask.get(policy.taskKey) ?? []), policy]);
    }
    // Ascending `priority` is the authored order of the chain; the elected
    // default outranks it, so it is hoisted regardless of where it sits.
    for (const [, rows] of byTask) {
      rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.priority - b.priority);
    }
    return [...byTask.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [policies.data]);

  const forbidden = policies.error instanceof GatewayError && policies.error.status === 403;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-labelledby="provider-configurations">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="provider-configurations" className="text-sm font-medium">
              Provider configurations
            </h2>
            <p className="text-muted-foreground text-xs">
              One row is one configuration: a connection, a model, and a place in the chain. Exactly one row per task may be the elected default.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="config-task-filter">Task</Label>
            <NativeSelect id="config-task-filter" value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)} className="w-56">
              <option value="">All tasks</option>
              {AI_TASK_KEYS.map((taskKey) => (
                <option key={taskKey} value={taskKey}>
                  {taskKey}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>

        {policies.isPending ? (
          <TableSkeleton />
        ) : forbidden ? (
          <EmptyState
            icon={IconPlugConnected}
            title="Managed by the platform"
            description="Provider configurations are authored by platform administrators. Your tenant inherits them, and brings its own credentials through Connections below."
          />
        ) : policies.error ? (
          <ErrorState error={policies.error} onRetry={() => void policies.refetch()} />
        ) : grouped.length === 0 ? (
          <EmptyState
            icon={IconPlugConnected}
            title="No provider configurations"
            description={
              scope.scope === 'system'
                ? 'The platform has no configured provider for any task in this filter. Model selection is fail-closed, so an unconfigured task cannot be served at all.'
                : 'This tenant has no configuration of its own for this filter, so every task here resolves to the platform default.'
            }
          />
        ) : (
          grouped.map(([taskKey, rows]) => (
            <div key={taskKey} className="flex flex-col gap-1.5">
              <h3 className="font-mono text-xs font-medium">
                {taskKey} <span className="text-muted-foreground">({rows.length})</span>
              </h3>
              <div className="rounded-md border">
                <Table aria-label={`Provider configurations for ${taskKey}`}>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Configuration</TableHead>
                      <TableHead scope="col">Model</TableHead>
                      <TableHead scope="col">State</TableHead>
                      <TableHead scope="col">Residency</TableHead>
                      <TableHead scope="col">Priority</TableHead>
                      <TableHead scope="col">Default</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((policy) => (
                      <TableRow key={policy.id}>
                        <TableCell className="text-xs">{policy.displayName ?? <span className="font-mono">{policy.id}</span>}</TableCell>
                        <TableCell className="font-mono text-xs">{policy.modelRef ?? policy.modelId ?? '—'}</TableCell>
                        <TableCell className="text-xs">
                          <div className="flex flex-wrap gap-1">
                            <Badge variant="outline">{policy.status}</Badge>
                            {!policy.enabled ? <Badge variant="secondary">Disabled</Badge> : null}
                            {policy.killSwitch ? <Badge variant="destructive">Kill switch</Badge> : null}
                            {/*
 NULL coverage is read as "not covered" by the
                                gates, so the console must not render it
                                as an unanswered question. 
*/}
                            {policy.baaCovered ? <Badge variant="outline">BAA</Badge> : null}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{policy.residency ?? '—'}</TableCell>
                        <TableCell className="font-mono text-xs">{policy.priority}</TableCell>
                        <TableCell>
                          <ElectDefaultButton policy={policy} scope={scope} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))
        )}
      </section>

      <Separator />

      <RequirePermission action="read" subject="GlobalSetting">
        <ProviderConnectionsSection />
      </RequirePermission>

      <Separator />

      <section className="flex flex-col gap-2" aria-labelledby="runtime-tuning">
        <h2 id="runtime-tuning" className="text-sm font-medium">
          Runtime tuning
        </h2>
        <p className="text-muted-foreground text-xs">
          Hyperparameters, concurrency and rate ceilings for a (provider, model) pair. These tune the configurations above rather than standing beside them,
          which is why the standalone rail entry was retired.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {runtimeProfiles.isPending ? (
            <Skeleton className="h-5 w-40" />
          ) : runtimeProfiles.error ? (
            <span className="text-muted-foreground text-xs">Platform-managed — not readable from this tenant scope.</span>
          ) : (
            <Badge variant="secondary">{runtimeProfiles.data.length} tuned pair(s)</Badge>
          )}
          <Button asChild variant="outline" size="sm">
            <Link href="/ai-runtime-profiles">
              <IconAdjustments aria-hidden />
              Open runtime profiles
              <IconExternalLink aria-hidden />
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
