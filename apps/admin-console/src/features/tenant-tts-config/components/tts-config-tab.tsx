'use client';

import { Fragment, useId } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, Skeleton } from '@arcaai/ui';
import { ErrorState } from '@/shared/state/error-state';
import { useTtsEffective, type EffectiveTtsConfig } from '../api';

/**
 * Voice tab — a READ-ONLY summary of the retired `TenantTtsConfig` row, plus the way forward.
 *
 * @deprecated TASK-862/879 — removed in R4 with `TenantTtsConfig`.
 *
 * TASK-879 made the speech path agent-first: the gateway resolves the tenant's TEXT_TO_SPEECH
 * agent per request and pushes a resolved spec that carries the engine chain, the bound model
 * (its mirror, artifacts and voices), the provider connections and the fallback governance. Every
 * field this tab used to EDIT now lives on a row that actually reaches `apps/tts`:
 *
 *   voice / format / speed / sample rate  → the agent's `parameters`
 *   routing chains + allowed providers    → the agent's model chain and the connection rows'
 *                                           three-state `enabled`
 *   voice bindings                        → `AiModel._metadata.voices`
 *
 * The editor is therefore GONE rather than disabled: a form that writes a row nothing reads is
 * worse than no form — an operator would change a value, see it saved, and hear no difference.
 * The summary stays for the deprecation window so an admin can SEE what the old row held while
 * migrating it, and the links go to the surfaces that own each half now.
 */
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
        <h3 id={`${uid}-title`} className="text-sm font-medium">
          Retired TTS config row
        </h3>
        <Badge variant="outline">read-only</Badge>
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
    <div className="flex flex-col gap-4 py-4" aria-hidden>
      <Skeleton className="h-5 w-72" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-64 w-full max-w-md" />
    </div>
  );
}

export function TtsConfigTab() {
  const effectiveQuery = useTtsEffective();

  if (effectiveQuery.isPending) return <ConfigTabSkeleton />;
  if (effectiveQuery.error || !effectiveQuery.data) {
    return <ErrorState error={effectiveQuery.error} onRetry={() => void effectiveQuery.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <h2 className="text-base font-semibold">Voice settings moved to the text-to-speech agent</h2>
      <Alert>
        <AlertTitle>Retired (TASK-879 — removed in R4)</AlertTitle>
        <AlertDescription>
          The tenant TTS config row no longer reaches the speech service. The voice, format, speed and sample rate are the
          text-to-speech agent&apos;s <span className="font-mono">parameters</span>; the provider order is the agent&apos;s model chain
          and its fallback block; which engines may serve, and on whose key, is the provider connection. The values below are what the
          old row still holds, kept visible while you migrate them.
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href="/agents?task=TEXT_TO_SPEECH">Open text-to-speech agents</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/workflow-studio/assignments">Agent assignments</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/ai-providers">Providers &amp; keys</Link>
        </Button>
      </div>
      <EffectiveResolveCard effective={effectiveQuery.data} />
    </div>
  );
}
