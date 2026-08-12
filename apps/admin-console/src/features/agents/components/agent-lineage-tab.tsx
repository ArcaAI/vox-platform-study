'use client';

/**
 * Lineage tab (TASK-672) — the console surface TASK-667 OI-3 flagged as
 * missing: with no environment concept on this platform (TASK-654 D9/G4),
 * the immutable `DepartmentAgentVersion` history TASK-659 writes on every
 * loop-config-affecting save is the ONLY remaining control on a weakened
 * clinical check, so an admin must be able to see what changed, when, and by
 * whom — and, where present, which cross-tenant promotion (TASK-663) brought
 * this agent's configuration in.
 *
 * Two read-only sections: "Config versions" (the version list + a client-side
 * field diff between two picked versions — there is no server diff endpoint
 * for this resource, unlike PromptTemplate's `:from/diff/:to`) and
 * "Promotion lineage" (`GET admin/agent-promotions?targetAgentId=`, scoped to
 * promotions INTO the working tenant).
 */

import { useState } from 'react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { CopyButton } from '@/shared/copy-button';
import { formatDateTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useAgentPromotionsForTarget, useDepartmentAgentVersions } from '../api/hooks';
import type { AgentPromotion, DepartmentAgent } from '../api/types';
import { diffConfigSnapshots, formatSnapshotValue } from './agent-version-lineage';

function ConfigVersionsSection({ agentId }: { agentId: string }) {
  const versionsQuery = useDepartmentAgentVersions(agentId);
  const [fromPick, setFromPick] = useState('');
  const [toPick, setToPick] = useState('');

  if (versionsQuery.isPending) {
    return (
      <Card className="gap-3 p-4">
        <div className="flex flex-col gap-2" aria-hidden>
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      </Card>
    );
  }

  if (versionsQuery.error) {
    return (
      <Card className="gap-3 p-4">
        <ErrorState error={versionsQuery.error} onRetry={() => void versionsQuery.refetch()} />
      </Card>
    );
  }

  const versions = [...(versionsQuery.data ?? [])].sort((a, b) => b.versionNumber - a.versionNumber);

  if (versions.length === 0) {
    return (
      <Card className="gap-3 p-4">
        <h3 className="text-sm font-semibold">Config versions</h3>
        <p className="text-muted-foreground text-sm">
          No loop-configuration versions recorded yet — a version is written the first time this agent's role, subscribed kinds, write scope, goal,
          guardrail profile, or always/never actions are set.
        </p>
      </Card>
    );
  }

  const to = toPick ? Number(toPick) : (versions[0]?.versionNumber ?? null);
  const from = fromPick ? Number(fromPick) : (versions[1]?.versionNumber ?? null);
  const toVersion = versions.find((version) => version.versionNumber === to) ?? null;
  const fromVersion = versions.find((version) => version.versionNumber === from) ?? null;
  const diff = fromVersion && toVersion ? diffConfigSnapshots(fromVersion.configSnapshot, toVersion.configSnapshot) : [];

  return (
    <Card className="gap-4 p-4">
      <h3 className="text-sm font-semibold">Config versions</h3>
      <ol aria-label="Loop-configuration versions" className="flex flex-col gap-1">
        {versions.map((version) => (
          <li key={version.id} className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="w-8 shrink-0 font-mono text-xs">v{version.versionNumber}</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{version.changeReason ?? '—'}</span>
            <span className="text-muted-foreground shrink-0 font-mono text-xs">{version.createdBy ?? '—'}</span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatDateTime(version.createdAt, 'date')}</span>
          </li>
        ))}
      </ol>
      {versions.length < 2 ? (
        <p className="text-muted-foreground text-xs">Only one version yet — nothing to diff.</p>
      ) : (
        <>
          <Separator />
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect aria-label="Diff from version" value={fromPick || String(from ?? '')} onChange={(event) => setFromPick(event.target.value)} className="h-8 w-20 text-xs">
              {versions.map((version) => (
                <NativeSelectOption key={version.id} value={String(version.versionNumber)}>
                  v{version.versionNumber}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <span aria-hidden className="text-muted-foreground text-xs">
              {'⇄'}
            </span>
            <NativeSelect aria-label="Diff to version" value={toPick || String(to ?? '')} onChange={(event) => setToPick(event.target.value)} className="h-8 w-20 text-xs">
              {versions.map((version) => (
                <NativeSelectOption key={version.id} value={String(version.versionNumber)}>
                  v{version.versionNumber}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {from === to ? (
            <p className="text-muted-foreground text-xs">Pick two different versions to compare.</p>
          ) : diff.length === 0 ? (
            <p className="text-muted-foreground text-xs">No field differs between v{from} and v{to}.</p>
          ) : (
            <dl aria-label={`Changes between v${from} and v${to}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
              {diff.map((entry) => (
                <div key={entry.field} className="col-span-2 grid grid-cols-subgrid">
                  <dt className="text-muted-foreground font-mono">{entry.field}</dt>
                  <dd className="flex min-w-0 flex-wrap items-center gap-1 font-mono break-words">
                    <span className="text-destructive">{formatSnapshotValue(entry.before)}</span>
                    <span aria-hidden className="text-muted-foreground">
                      {'→'}
                    </span>
                    <span className="text-success">{formatSnapshotValue(entry.after)}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </Card>
  );
}

function PromotionRow({ promotion }: { promotion: AgentPromotion }) {
  return (
    <li>
      <Card className="gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">From tenant</span>
          <span className="font-mono text-xs">{promotion.fromTenantId}</span>
          <CopyButton value={promotion.fromTenantId} label="Copy source tenant id" />
          {promotion.drifted === true ? (
            <Badge variant="outline" className="border-warning/40 text-warning-strong">
              Drifted since promotion
            </Badge>
          ) : promotion.drifted === false ? (
            <Badge variant="secondary">Up to date</Badge>
          ) : null}
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span>{promotion.promotedBy ?? '—'}</span>
          <span aria-hidden>&middot;</span>
          <span className="tabular-nums">{formatDateTime(promotion.createdAt)}</span>
          {promotion.evalRunId ? (
            <>
              <span aria-hidden>&middot;</span>
              <span>Re-evaluated at target</span>
            </>
          ) : null}
        </div>
        {promotion.warnings.length > 0 ? (
          <ul className="text-warning-strong flex flex-col gap-0.5 text-xs">
            {promotion.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </Card>
    </li>
  );
}

function PromotionLineageSection({ agentId }: { agentId: string }) {
  const promotionsQuery = useAgentPromotionsForTarget(agentId);

  if (promotionsQuery.isPending) {
    return (
      <Card className="gap-3 p-4">
        <Skeleton className="h-16 w-full" aria-hidden />
      </Card>
    );
  }

  if (promotionsQuery.error) {
    return (
      <Card className="gap-3 p-4">
        <ErrorState error={promotionsQuery.error} onRetry={() => void promotionsQuery.refetch()} />
      </Card>
    );
  }

  const promotions = promotionsQuery.data?.data ?? [];

  return (
    <Card className="gap-3 p-4">
      <h3 className="text-sm font-semibold">Promotion lineage</h3>
      {promotions.length === 0 ? (
        <p className="text-muted-foreground text-sm">This agent was not created by a cross-tenant promotion.</p>
      ) : (
        <ul aria-label="Promotions into this agent" className="flex flex-col gap-2">
          {promotions.map((promotion) => (
            <PromotionRow key={promotion.id} promotion={promotion} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function AgentLineageTab({ agent }: { agent: DepartmentAgent }) {
  return (
    <div className="flex flex-col gap-4">
      <ConfigVersionsSection agentId={agent.id} />
      <PromotionLineageSection agentId={agent.id} />
    </div>
  );
}
