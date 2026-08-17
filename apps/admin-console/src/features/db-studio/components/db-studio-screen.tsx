'use client';

import { IconAlertTriangle, IconDatabaseOff, IconExternalLink } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useDbStudioStatus } from '../api/hooks';

/**
 * The status payload only proves enablement, so the embed target is the
 * BFF-proxied gateway shell (GET /admin/pstudio serves the studio HTML behind
 * the session guard — same path the api client uses, minus /status).
 */
const STUDIO_SRC = '/api/hope/admin/pstudio';

const SURFACE_CLASS = 'min-h-0 w-full flex-1 rounded-md border';

function StudioSurface() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge>Enabled</Badge>
          <span className="text-muted-foreground font-mono text-xs">{STUDIO_SRC}</span>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a href={STUDIO_SRC} target="_blank" rel="noopener noreferrer">
            <IconExternalLink aria-hidden />
            Open in new tab
          </a>
        </Button>
      </div>
      {/* The console only provides the guarded shell — the studio renders inside. */}
      <iframe title="Database Studio" src={STUDIO_SRC} sandbox="allow-scripts allow-same-origin allow-forms" className={`${SURFACE_CLASS} bg-card`} />
    </div>
  );
}

function DisabledCard() {
  return (
    <Card className="min-h-0 w-full flex-1 justify-center">
      <EmptyState
        icon={IconDatabaseOff}
        title="Database Studio is disabled"
        description={
          <>
            The studio shell is off in this environment (fail-closed). The gateway enables it only when the operator sets{' '}
            <code className="font-mono">ENABLE_PRISMA_STUDIO=true</code>; access additionally requires the dedicated{' '}
            <code className="font-mono">manage:PrismaStudio</code> permission (TASK-419). No broken iframe is shown.
          </>
        }
      />
    </Card>
  );
}

function LoadingSurface() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-8 w-36" />
      </div>
      <Skeleton className={SURFACE_CLASS} />
    </div>
  );
}

/**
 * Frame 19 — Database Studio: truthful enabled/disabled surface from
 * GET /admin/pstudio/status; the iframe shell renders only when the gateway
 * confirms the studio module is registered.
 *
 * NAMING: the CONSOLE route and copy are `/db-studio` /
 * "Database Studio" — "pstudio" read as a typo'd "prompt studio" next to
 * `/prompt-studio`. The GATEWAY path stays `/admin/pstudio/*` deliberately:
 * renaming it is a backend API change with its own compatibility story, and
 * this ticket owns console naming only. So the two names differing below is
 * intentional, not drift.
 */
export function DbStudioScreen() {
  const statusQuery = useDbStudioStatus();

  return (
    <ScreenTemplate
      contentMode="fill"
      header={
        <PageHeader
          title="Database Studio"
          meta={
            <>
              <span>Embedded database browser</span>
              <span aria-hidden>&middot;</span>
              <span>Super Admin only</span>
            </>
          }
        />
      }
      statusBanner={
        <Alert>
          <IconAlertTriangle aria-hidden />
          <AlertTitle>Production data</AlertTitle>
          <AlertDescription>Every write here bypasses domain rules and is audit-logged. Prefer admin screens for routine edits.</AlertDescription>
        </Alert>
      }
      footer={
        <StatusFooter
          start={<span>{statusQuery.data?.enabled ? 'Studio enabled' : 'Studio disabled'}</span>}
          end={
            <span aria-hidden className="font-mono">
              {STUDIO_SRC}
            </span>
          }
        />
      }
    >
      {statusQuery.isLoading ? (
        <LoadingSurface />
      ) : statusQuery.error ? (
        <div className="flex min-h-0 flex-1 flex-col justify-center">
          <ErrorState error={statusQuery.error} onRetry={() => void statusQuery.refetch()} />
        </div>
      ) : statusQuery.data?.enabled ? (
        <StudioSurface />
      ) : (
        <DisabledCard />
      )}
    </ScreenTemplate>
  );
}
