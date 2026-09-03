'use client';

import { IconAlertTriangle, IconArrowNarrowRight, IconCircleCheck } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import type { EffectiveRoutingPolicy, RejectedRoutingCandidate, ResolvedRoutingCandidate } from '../api/types';

function CandidateLine({ candidate, primary }: { candidate: ResolvedRoutingCandidate; primary?: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-2 text-xs">
      {primary ? (
        <Badge variant="default" className="gap-1">
          <IconCircleCheck aria-hidden className="size-3" />
          Primary
        </Badge>
      ) : (
        <Badge variant="outline" className="gap-1">
          <IconArrowNarrowRight aria-hidden className="size-3" />
          Fallback {candidate.step}
        </Badge>
      )}
      <span className="font-mono">{candidate.connectionRef || '—'}</span>
      <span aria-hidden className="text-muted-foreground">
        ·
      </span>
      <span className="font-mono">{candidate.model || '—'}</span>
      {/* Funding is DERIVED from which tier supplied the credential, never
          stamped — rendering it is how an administrator sees that a tenant's
          own key is actually being used before the invoice says otherwise. */}
      <Badge variant="secondary">{candidate.funding}</Badge>
      {candidate.baaCovered ? <Badge variant="outline">BAA</Badge> : null}
      {candidate.residency ? <Badge variant="outline">{candidate.residency}</Badge> : null}
    </li>
  );
}

function RejectedLine({ candidate }: { candidate: RejectedRoutingCandidate }) {
  return (
    <li className="flex flex-wrap items-center gap-2 text-xs">
      <Badge variant="outline" className="gap-1">
        <IconAlertTriangle aria-hidden className="size-3" />
        Refused
      </Badge>
      <span className="font-mono">{candidate.connectionRef || '—'}</span>
      <span aria-hidden className="text-muted-foreground">
        ·
      </span>
      <span className="font-mono">{candidate.model || '—'}</span>
      <span className="text-muted-foreground">{candidate.reason}</span>
    </li>
  );
}

/**
 * One AI task, showing what ACTUALLY serves it: the elected primary, the
 * already-gated fallback chain in order, and every candidate the resolver
 * refused with the gate that refused it.
 *
 * The chain rendered here is the resolver's own answer, not a re-derivation
 * from the rows: a hop that would cross residency class, BAA coverage or
 * funding tier arrives under `rejectedCandidates`, so the screen cannot show a
 * fallback the runtime would never take. Before this was a string join
 * and there was nothing to render at all (program finding F-6).
 */
export function TaskRoutingCard({
  taskKey,
  data,
  error,
  isPending,
}: {
  taskKey: string;
  data: EffectiveRoutingPolicy | undefined;
  error: unknown;
  isPending: boolean;
}) {
  const forbidden = error instanceof GatewayError && error.status === 403;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono">{taskKey}</span>
          {data?.source ? (
            <Badge variant={data.source === 'tenant' ? 'default' : 'secondary'}>
              {data.source === 'tenant' ? 'Tenant configuration' : 'Inherited platform default'}
            </Badge>
          ) : null}
          {data?.relaxedGates?.length ? <Badge variant="destructive">Relaxed: {data.relaxedGates.join(', ')}</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {isPending ? (
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : forbidden ? (
          <p className="text-muted-foreground text-xs">
            Routing for this task is managed by the platform. Your tenant inherits the platform default and cannot override it here.
          </p>
        ) : error ? (
          <p className="text-destructive text-xs">{error instanceof Error ? error.message : 'Could not resolve this task.'}</p>
        ) : data?.rejection ? (
          // Selection is fail-CLOSED: nothing is substituted, so the console
          // says so plainly rather than showing an empty chain that reads like
          // "not configured yet".
          <p className="text-destructive flex items-start gap-1.5 text-xs">
            <IconAlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <span className="font-mono">{data.rejection.code}</span> — {data.rejection.message}
              {data.rejection.retryable === false ? ' (retrying will not help; this is a policy gate)' : null}
            </span>
          </p>
        ) : !data?.primary ? (
          <p className="text-muted-foreground text-xs">No provider configuration serves this task in either tier.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            <CandidateLine candidate={data.primary} primary />
            {data.fallbackChain.map((candidate) => (
              <CandidateLine key={`${candidate.step}-${candidate.connectionRef}-${candidate.model}`} candidate={candidate} />
            ))}
          </ul>
        )}

        {data?.rejectedCandidates?.length ? (
          <details className="text-xs">
            <summary className="text-muted-foreground cursor-pointer">{data.rejectedCandidates.length} refused candidate(s)</summary>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {data.rejectedCandidates.map((candidate) => (
                <RejectedLine key={`${candidate.rank}-${candidate.connectionRef}-${candidate.model}`} candidate={candidate} />
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
