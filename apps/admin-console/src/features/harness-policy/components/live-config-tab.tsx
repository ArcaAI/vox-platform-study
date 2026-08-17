'use client';

import { IconExternalLink } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatRelativeTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useLiveDocConfig } from '../api';

/**
 * Live config tab (frame 36) — READ-ONLY summary of the live-documentation
 * engine kill-switch.
 *
 * This tab used to carry a second editor for
 * `PATCH /admin/harness/live/config` — the exact row `/agentic-policy` (tier
 * 10-19) already edits. Two editors over one row means two OCC clients and two
 * places to keep in step, so this one demotes to a summary + deep link and
 * `/agentic-policy` becomes the single authoritative editor.
 *
 * VERIFIED contract note (unchanged): `LiveDocEngineConfigResponse` carries only
 * the enabled flag plus env-default/source metadata — NOT the "max sessions ·
 * stage timeouts" the frame annotation suggests.
 *
 * Elevated-only: the caller gates the tab, and the gateway asserts platform
 * admin in code regardless.
 */
export function LiveConfigTab() {
  const configQuery = useLiveDocConfig(true);

  if (configQuery.isPending) {
    return (
      <Card className="gap-4 p-6" aria-hidden>
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-8 w-full max-w-md" />
        <Skeleton className="h-9 w-40" />
      </Card>
    );
  }
  if (configQuery.error || !configQuery.data) {
    return <ErrorState error={configQuery.error} onRetry={() => void configQuery.refetch()} />;
  }

  const config = configQuery.data;

  return (
    <Card className="max-w-2xl gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Live documentation engine</h2>
        <p className="text-muted-foreground text-sm">
          Runtime kill-switch (super admin, global scope). A Redis override fans out to every API instance &mdash; no redeploy. Disabling refuses new
          sessions while in-flight ones drain. Edited from Agentic policy, which owns this row.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={config.enabled ? 'default' : 'destructive'}>
          {config.enabled ? 'Engine enabled' : 'Engine disabled (kill-switch engaged)'}
        </Badge>
        <Badge variant="outline" className="font-mono text-[10px]">
          env default: {config.envDefault ? 'enabled' : 'disabled'}
        </Badge>
        <Badge variant="outline" className="font-mono text-[10px]">
          source: {config.source}
        </Badge>
        {config.updatedAt ? <span className="text-muted-foreground text-xs">overridden {formatRelativeTime(config.updatedAt)}</span> : null}
      </div>

      <div className="flex justify-end">
        {/*
         * Plain href, not a cross-feature import: rule 13 keeps features
         * isolated, and this is a different tier's screen.
         */}
        <Button variant="outline" asChild>
          <a href="/agentic-policy?tab=engine">
            <IconExternalLink aria-hidden />
            Edit in Agentic policy
          </a>
        </Button>
      </div>
    </Card>
  );
}
