'use client';

import { IconRadar2, IconRefresh } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { StatCard } from '@arcaai/ui/components/metrics';
import { formatDateTime, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useInferenceReadiness, useRefreshInferenceReadiness } from '../api';
import type { InferenceReadiness, ModelReadiness, ReadinessEngine, ReadinessModel, ReadinessService } from '../api/types';

/**
 * Readiness — the platform's last observation of every inference surface
 * (TASK-890 §3.12, OD-L).
 *
 * ─── What this screen is careful about ─────────────────────────────────────
 * It renders an OBSERVATION, not a live state, and everything here exists to
 * keep those two apart. `checkedAt` is always on screen; "not probed" and
 * "never seen" are their own labels rather than being folded into "down"; and
 * an empty document says so instead of drawing an all-clear grid it never
 * measured. A monitoring screen that overstates its own freshness is worse than
 * no screen, because an operator acts on it.
 *
 * Colour never carries meaning alone (rule 11 §10): every badge says its state
 * in words, and every non-ready model shows the reason the sweep gave.
 */

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

const ENGINE_STATUS_META: Record<ReadinessEngine['status'], { label: string; variant: BadgeVariant }> = {
  up: { label: 'Up', variant: 'default' },
  down: { label: 'Down', variant: 'destructive' },
  // Nobody looked. Distinct from `down`, and a different fix.
  unknown: { label: 'Not probed', variant: 'outline' },
};

const READINESS_META: Record<ModelReadiness, { label: string; variant: BadgeVariant }> = {
  ready: { label: 'Ready', variant: 'default' },
  loadable: { label: 'Loadable', variant: 'secondary' },
  engine_down: { label: 'Engine down', variant: 'destructive' },
  weights_missing: { label: 'Weights missing', variant: 'destructive' },
  credential_missing: { label: 'No credential', variant: 'destructive' },
  unknown: { label: 'Not measured', variant: 'outline' },
};

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    // The landmark wraps the Card rather than replacing it: `Card` takes no
    // `asChild`, and an operator navigating by region should land on the whole
    // block, header included.
    <section aria-label={title}>
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-col gap-1 border-b px-4 py-3">
          <h2 className="text-sm font-medium">{title}</h2>
          {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
        </div>
        <div className="px-4 py-1">{children}</div>
      </Card>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0">{children}</li>;
}

function EngineRow({ engine }: { engine: ReadinessEngine }) {
  const meta = ENGINE_STATUS_META[engine.status];
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">{engine.provider}</span>
          <Badge variant={meta.variant}>{meta.label}</Badge>
        </div>
        <span className="text-muted-foreground truncate font-mono text-xs">{engine.baseUrlHost ?? 'no endpoint resolved'}</span>
        {engine.detail ? <span className="text-muted-foreground text-xs">{engine.detail}</span> : null}
      </div>
      <div className="text-muted-foreground flex shrink-0 items-center gap-4 text-xs tabular-nums">
        <span>{engine.status === 'up' ? `${engine.loadedCount}/${engine.listedCount} loaded` : '—'}</span>
        <span>{typeof engine.latencyMs === 'number' ? `${engine.latencyMs} ms` : '—'}</span>
      </div>
    </Row>
  );
}

function ServiceRow({ service }: { service: ReadinessService }) {
  return (
    <Row>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{service.key}</span>
        <Badge variant={service.healthy ? 'default' : 'destructive'}>{service.healthy ? 'Healthy' : 'Not healthy'}</Badge>
      </div>
      <span className="text-muted-foreground shrink-0 text-xs" title={service.lastSeenAt ? formatDateTime(service.lastSeenAt) : undefined}>
        {service.lastSeenAt ? `Last heartbeat ${formatRelativeTime(service.lastSeenAt)}` : 'Never seen'}
      </span>
    </Row>
  );
}

function ModelRow({ model }: { model: ReadinessModel }) {
  const meta = READINESS_META[model.readiness];
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">{model.slug}</span>
          <Badge variant={meta.variant}>{meta.label}</Badge>
        </div>
        <span className="text-muted-foreground text-xs">
          {model.provider ?? 'no provider'} · {model.taskType}
        </span>
        {model.detail ? <span className="text-muted-foreground text-xs">{model.detail}</span> : null}
      </div>
    </Row>
  );
}

function ReadinessSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
      {Array.from({ length: 2 }, (_, section) => (
        <div key={section} className="flex flex-col gap-3 rounded-md border p-4">
          <Skeleton className="h-4 w-40" />
          {Array.from({ length: 3 }, (_, row) => (
            <div key={row} className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-48 max-w-full" />
                <Skeleton className="h-5 w-32 rounded-full" />
              </div>
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ReadinessStats({ document }: { document: InferenceReadiness }) {
  const enginesUp = document.engines.filter((engine) => engine.status === 'up').length;
  const servicesHealthy = document.services.filter((service) => service.healthy).length;
  const modelsReady = document.models.filter((model) => model.readiness === 'ready').length;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Engines"
        value={`${enginesUp} of ${document.engines.length} up`}
        accent={enginesUp === document.engines.length ? 'success' : 'destructive'}
      />
      <StatCard
        label="Platform services"
        value={`${servicesHealthy} of ${document.services.length} healthy`}
        accent={servicesHealthy === document.services.length ? 'success' : 'destructive'}
      />
      <StatCard label="Models ready" value={`${modelsReady} of ${document.models.length} ready`} />
      <StatCard
        label="Observed"
        value={document.checkedAt ? formatRelativeTime(document.checkedAt) : '—'}
        hint={document.checkedAt ? formatDateTime(document.checkedAt) : undefined}
      />
    </div>
  );
}

export function ReadinessPanel() {
  const readinessQuery = useInferenceReadiness();
  const refresh = useRefreshInferenceReadiness();

  const probeNow = (
    <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
      {refresh.isPending ? <Spinner /> : <IconRefresh aria-hidden className="size-4" />}
      Probe now
    </Button>
  );

  if (readinessQuery.isPending) return <ReadinessSkeleton />;

  if (readinessQuery.error || !readinessQuery.data) {
    return <ErrorState title="Couldn’t load the readiness observation" error={readinessQuery.error} onRetry={() => void readinessQuery.refetch()} />;
  }

  const document = readinessQuery.data;

  // No observation is a STATE, not an error and not an all-clear. The sweep may
  // be switched off, the process may be cold, or the snapshot may have expired —
  // all three mean the same thing to an operator: nobody has looked yet.
  if (!document.checkedAt) {
    return (
      <EmptyState
        icon={IconRadar2}
        title="No readiness observation yet"
        description="The readiness sweep has not stored an observation. It may be switched off in Settings (inference.readiness.enabled), or this process may have just started. Nothing here is a claim about whether the engines are up."
        action={probeNow}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          The platform’s last observation, taken <span title={formatDateTime(document.checkedAt)}>{formatRelativeTime(document.checkedAt)}</span>.
          Nothing on this screen is measured on load.
        </p>
        {probeNow}
      </div>

      <ReadinessStats document={document} />

      <Section title="Inference engines" description="Probed through the text service, which is the only process that speaks to an engine.">
        <ul>
          {document.engines.map((engine) => (
            <EngineRow key={engine.provider} engine={engine} />
          ))}
        </ul>
      </Section>

      <Section title="Platform services" description="The six HOPE services, from the heartbeat the gateway records every 30 seconds.">
        <ul>
          {document.services.map((service) => (
            <ServiceRow key={service.key} service={service} />
          ))}
        </ul>
      </Section>

      <Section title="Model readiness" description="Every registry row, with the reason behind its state.">
        {document.models.length === 0 ? (
          <p className="text-muted-foreground py-3 text-sm">No catalogue rows were observed.</p>
        ) : (
          <ul>
            {document.models.map((model) => (
              <ModelRow key={model.id} model={model} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
