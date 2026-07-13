'use client';

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
import { useTtsEffective, useTtsRow, usePutTtsRow, type EffectiveTtsConfig } from '../api';
import { TtsConfigForm } from './tts-config-form';
import { TtsCredentialsTab } from './tts-credentials-tab';

const TAB_VALUES = ['config', 'credentials'] as const;

/** Compact key/value summary of the resolved effective TTS config. */
function EffectiveResolveCard({ effective }: { effective: EffectiveTtsConfig }) {
  const uid = useId();
  const list = (values: string[]) => (values.length > 0 ? values.join(', ') : '—');
  const summary: { label: string; value: string }[] = [
    { label: 'voice en', value: effective.defaultVoiceEn ?? '—' },
    { label: 'voice ml', value: effective.defaultVoiceMl ?? '—' },
    { label: 'format', value: effective.defaultFormat },
    { label: 'speed', value: String(effective.defaultSpeed) },
    { label: 'sample rate', value: `${effective.sampleRate} Hz` },
    { label: 'max chars', value: String(effective.maxInputChars) },
    { label: 'routing en', value: list(effective.routingEn) },
    { label: 'routing ml', value: list(effective.routingMl) },
    { label: 'allowed', value: list(effective.allowedProviders) },
    { label: 'sarvam public', value: effective.sarvamPublicApiAllowed ? 'on' : 'off' },
  ];
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${uid}-title`} className="text-sm font-semibold">
          Effective TTS config
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

function ConfigTabSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <Skeleton className="h-64 w-full max-w-md" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
    </div>
  );
}

/** Configuration tab: effective resolve card + the OCC row editor. */
function ConfigTab() {
  const uid = useId();
  const effectiveQuery = useTtsEffective();
  const rowQuery = useTtsRow();
  const mutation = usePutTtsRow();

  if (effectiveQuery.isPending || rowQuery.isPending) return <ConfigTabSkeleton />;
  if (effectiveQuery.error || !effectiveQuery.data) {
    return <ErrorState error={effectiveQuery.error} onRetry={() => void effectiveQuery.refetch()} />;
  }
  if (rowQuery.error || !rowQuery.data) {
    return <ErrorState error={rowQuery.error} onRetry={() => void rowQuery.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <EffectiveResolveCard effective={effectiveQuery.data} />
        <section aria-labelledby={`${uid}-editor`} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 id={`${uid}-editor`} className="text-base font-semibold">
              Tenant TTS config editor
            </h2>
            <p className="text-muted-foreground text-sm">
              Sparse patch over the row &mdash; <span className="font-mono text-xs">PUT /admin/tts-config/row</span> with If-Match; drift returns 412
              with reload-merge. Empty scalar = inherit the SYSTEM default.
            </p>
          </div>
          <TtsConfigForm
            row={rowQuery.data.data}
            etag={rowQuery.data.etag}
            mutation={mutation}
            onReloadLatest={() => void rowQuery.refetch()}
            successMessage="Tenant TTS config saved"
          />
        </section>
      </div>
    </div>
  );
}

/**
 * TASK-504 Phase 4 — Tenant TTS configuration (/tts-config, tier 30-49).
 * Tenant-scoped effective config with OCC row editing, plus BYO provider-key
 * management (write-only, Vault-encrypted). Built to the design-system best
 * practices (ScreenTemplate, skeletons, both themes, semantic tokens).
 */
export function TenantTtsConfigScreen() {
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('config'));
  const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'config';

  return (
    <WorkingTenantGate
      title="TTS Configuration"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/tts-config
        </span>
      }
    >
      <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTabParam(next === 'config' ? null : next)}>
        <ScreenTemplate
          header={<PageHeader title="TTS Configuration" meta={<span>tenant voices, routing &amp; BYO provider keys</span>} />}
          tabs={
            <TabsList variant="line">
              <TabsTrigger value="config">Configuration</TabsTrigger>
              <TabsTrigger value="credentials">Credentials</TabsTrigger>
            </TabsList>
          }
          footer={
            <StatusFooter
              end={
                <span aria-hidden className="font-mono">
                  GET /admin/tts-config
                </span>
              }
            />
          }
        >
          <TabsContent value="config">
            <ConfigTab />
          </TabsContent>
          <TabsContent value="credentials">
            <TtsCredentialsTab />
          </TabsContent>
        </ScreenTemplate>
      </Tabs>
    </WorkingTenantGate>
  );
}
