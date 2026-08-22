'use client';

import { Fragment, useId } from 'react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ErrorState } from '@/shared/state/error-state';
import { useTtsCatalog, useTtsEffective, useTtsRow, usePutTtsRow, type EffectiveTtsConfig } from '../api';
import { TtsConfigForm } from './tts-config-form';

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
    // Effective merged bindings, read-only (tenant over SYSTEM per voice id).
    ...Object.entries(effective.voiceBindings ?? {}).map(([voiceId, bindings]) => ({
      label: `bind ${voiceId}`,
      value: Object.entries(bindings)
        .map(([provider, voice]) => `${provider}:${voice}`)
        .join(', '),
    })),
  ];
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${uid}-title`} className="text-sm font-medium">
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
        {/* Voice-bindings card: per-voice rows of provider selects (rule 10: mirror the loaded shape). */}
        <div className="flex flex-col gap-3 lg:col-span-2">
          <Skeleton className="h-5 w-32" />
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Voice (TTS config) tab body — effective resolve card + the OCC row editor.
 * Extracted from the retired `/tts-config` screen so the `/ai-configuration`
 * hub can compose it as its "Voice" tab. The BYO TTS credentials
 * formerly beside it are now edited only in the hub's Providers tab (the
 * unified provider plane) — the one authoritative credential editor (rule 13).
 */
export function TtsConfigTab() {
  const uid = useId();
  const effectiveQuery = useTtsEffective();
  const rowQuery = useTtsRow();
  // Catalog failure degrades gracefully: the bindings editor is hidden, the rest of the form stays editable.
  const catalogQuery = useTtsCatalog();
  const mutation = usePutTtsRow();

  if (effectiveQuery.isPending || rowQuery.isPending || catalogQuery.isPending) return <ConfigTabSkeleton />;
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
            <h2 id={`${uid}-editor`} className="text-base font-medium">
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
            catalog={catalogQuery.data}
            effectiveBindings={effectiveQuery.data.voiceBindings}
          />
        </section>
      </div>
    </div>
  );
}
