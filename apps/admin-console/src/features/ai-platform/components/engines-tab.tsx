'use client';

import Link from 'next/link';
import { IconAtom, IconCpu2, IconExternalLink, IconServerBolt } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useEngineHealth, type EngineProbe } from '../api/engine-health-client';

/**
 * The engines whose health this tab reports.
 *
 * The two LLM engines are PROBED through discovery; MLflow is a registry rather
 * than an inference engine, so it has no probe on this path and is listed as a
 * link only. Saying that plainly beats rendering a permanently "unknown" badge
 * next to it, which reads as a broken probe rather than an absent one.
 */
const PROBED_ENGINES = [
  { provider: 'lm-studio', label: 'LM Studio', route: '/ai-services/lm-studio', icon: IconCpu2 },
  { provider: 'vllm', label: 'vLLM', route: '/ai-services/vllm', icon: IconServerBolt },
] as const;

function probeBadge(probe: EngineProbe | undefined) {
  if (!probe) return <Badge variant="outline">No probe reported</Badge>;
  if (probe.probeStatus === 'ok') return <Badge variant="default">Reachable</Badge>;
  if (probe.probeStatus === 'skipped') return <Badge variant="secondary">Not probed</Badge>;
  // Never colour alone: the word carries the meaning too (rule 11 §10).
  return <Badge variant="destructive">{probe.probeStatus === 'timeout' ? 'Timed out' : 'Unreachable'}</Badge>;
}

/**
 * ENGINES — the platform's serving inventory at a glance.
 *
 * Deliberately shallow: it answers "which engines does this platform have, and
 * are they up", and hands off to the per-engine screens for everything else.
 * Those routes are NOT retired — `inference-engines/components/engine-meta.ts`
 * argues on the record that an engine's status needs its own linkable URL and
 * that the rail IS the inventory, and consolidation does not change either.
 */
export function EnginesTab({ enabled }: { enabled: boolean }) {
  const results = useEngineHealth(
    PROBED_ENGINES.map((engine) => engine.provider),
    enabled,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {PROBED_ENGINES.map((engine, index) => {
          const result = results[index];
          const probe = result?.data?.probes.find((entry) => entry.provider === engine.provider) ?? result?.data?.probes[0];
          const Icon = engine.icon;
          return (
            <Card key={engine.provider}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Icon aria-hidden className="size-4" />
                  {engine.label}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-xs">
                {result?.isPending ? (
                  <div className="flex flex-col gap-2" aria-hidden>
                    <Skeleton className="h-5 w-28 rounded-full" />
                    <Skeleton className="h-4 w-40" />
                  </div>
                ) : result?.error ? (
                  // A rejected QUERY is the gateway read failing, which is a
                  // different and rarer thing than an unreachable engine.
                  <p className="text-destructive">Could not read engine state: {result.error instanceof Error ? result.error.message : 'unknown error'}</p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      {probeBadge(probe)}
                      {probe?.latencyMs !== undefined ? <span className="text-muted-foreground font-mono">{probe.latencyMs} ms</span> : null}
                      {probe?.connectionSource ? (
                        <Badge variant="outline">{probe.connectionSource === 'tenant' ? 'Tenant connection' : 'Platform connection'}</Badge>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground">{result?.data?.entries.length ?? 0} model(s) reported by the engine</p>
                    {probe?.error ? <p className="text-destructive break-words">{probe.error}</p> : null}
                  </>
                )}
                <Button asChild variant="outline" size="sm" className="self-start">
                  <Link href={engine.route}>
                    Open {engine.label}
                    <IconExternalLink aria-hidden />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <IconAtom aria-hidden className="size-4" />
              MLflow
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-xs">
            <p className="text-muted-foreground">
              A model registry, not an inference engine — it is not on the discovery probe path, so no reachability is reported here.
            </p>
            <Button asChild variant="outline" size="sm" className="self-start">
              <Link href="/ai-services/mlflow">
                Open MLflow
                <IconExternalLink aria-hidden />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
