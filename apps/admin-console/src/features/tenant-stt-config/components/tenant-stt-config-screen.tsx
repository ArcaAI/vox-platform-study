'use client';

/**
 * ⚠️ DESIGN GATE OPEN — DO NOT MERGE (rule 12).
 * This screen has NO approved Figma frame and NO recorded owner waiver. It is
 * built by composing already-approved patterns (ScreenTemplate, WorkingTenantGate
 * + acting-on gate, the TTS CredentialCard tab, OccConflictAlert) — the TASK-526
 * waiver-precedent SHAPE — but that precedent is a REASONABLE ASK, not a granted
 * approval. Until the owner grants a frame or records a waiver in the ticket
 * README, this route MUST NOT ship: it is intentionally left OUT of the sidebar
 * nav (reachable only by direct URL), exactly like an `implemented: false` entry.
 * See docs/implementation/TASK-567-Tenant-STT-Fallback-Provider-BYOK/README.md
 * (Phase G / Change History) for the open-gate note.
 */

import { Fragment, useId } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useSttEffective, useSttFallbackCandidates, useSttRow, usePutSttRow, type EffectiveSttConfig } from '../api';
import { SttFallbackForm } from './stt-fallback-form';
import { SttCredentialsTab } from './stt-credentials-tab';

const TAB_VALUES = ['fallback', 'credentials'] as const;

/** Compact key/value summary of the resolved effective STT fallback spec. */
function EffectiveResolveCard({ effective }: { effective: EffectiveSttConfig }) {
  const uid = useId();
  const summary: { label: string; value: string }[] = [
    { label: 'fallback pipeline', value: effective.fallbackPipelineId ?? '—' },
    { label: 'auto-switch', value: effective.autoSwitchEnabled ? 'on' : 'off' },
    { label: 'failure threshold', value: String(effective.consecutiveFailureThreshold) },
  ];
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${uid}-title`} className="text-sm font-semibold">
          Effective STT fallback
        </h2>
        <Badge variant="secondary">tenant over SYSTEM default</Badge>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        {summary.map((row) => (
          <Fragment key={row.label}>
            <dt className="text-muted-foreground font-mono text-xs">{row.label}</dt>
            <dd className="min-w-0 truncate font-mono text-xs">{row.value}</dd>
          </Fragment>
        ))}
      </dl>
    </Card>
  );
}

function FallbackTabSkeleton() {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" aria-hidden>
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
    </div>
  );
}

/** Fallback tab: effective resolve card + the OCC fallback-row editor. */
function FallbackTab() {
  const uid = useId();
  const effectiveQuery = useSttEffective();
  const rowQuery = useSttRow();
  const candidatesQuery = useSttFallbackCandidates();
  const mutation = usePutSttRow();

  if (effectiveQuery.isPending || rowQuery.isPending || candidatesQuery.isPending) return <FallbackTabSkeleton />;
  if (effectiveQuery.error || !effectiveQuery.data) {
    return <ErrorState error={effectiveQuery.error} onRetry={() => void effectiveQuery.refetch()} />;
  }
  if (rowQuery.error || !rowQuery.data) {
    return <ErrorState error={rowQuery.error} onRetry={() => void rowQuery.refetch()} />;
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <EffectiveResolveCard effective={effectiveQuery.data} />
      <section aria-labelledby={`${uid}-editor`} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={`${uid}-editor`} className="text-base font-semibold">
            Tenant STT fallback editor
          </h2>
          <p className="text-muted-foreground text-sm">
            Sparse write over the row &mdash; <span className="font-mono text-xs">PUT /admin/stt-config/row</span> with If-Match; drift returns 412
            with reload-merge.
          </p>
        </div>
        <SttFallbackForm
          row={rowQuery.data.data}
          candidates={candidatesQuery.data ?? []}
          mutation={mutation}
          onReloadLatest={() => void rowQuery.refetch()}
        />
      </section>
    </div>
  );
}

/**
 * Tenant STT configuration (/stt-config, tier 30-49).
 * Tenant-scoped fallback spec with OCC row editing, plus BYO provider-key
 * management (write-only, Vault-encrypted). Composed from the design-system
 * best practices (ScreenTemplate, WorkingTenantGate, skeletons, both themes,
 * semantic tokens) — but the rule-12 design gate is OPEN (see header).
 */
export function TenantSttConfigScreen() {
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('fallback'));
  const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'fallback';

  return (
    <WorkingTenantGate
      title="STT Configuration"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/stt-config
        </span>
      }
    >
      <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTabParam(next === 'fallback' ? null : next)}>
        <ScreenTemplate
          header={<PageHeader title="STT Configuration" meta={<span>tenant fallback pipeline &amp; BYO provider keys</span>} />}
          tabs={
            <TabsList variant="line">
              <TabsTrigger value="fallback">Fallback</TabsTrigger>
              <TabsTrigger value="credentials">Credentials</TabsTrigger>
            </TabsList>
          }
          footer={
            <StatusFooter
              end={
                <span aria-hidden className="font-mono">
                  GET /admin/stt-config
                </span>
              }
            />
          }
        >
          <TabsContent value="fallback">
            <FallbackTab />
          </TabsContent>
          <TabsContent value="credentials">
            <SttCredentialsTab />
          </TabsContent>
        </ScreenTemplate>
      </Tabs>
    </WorkingTenantGate>
  );
}
