import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { usePrismaStudio } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Database, ExternalLink } from 'lucide-react';
import { useEffect } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { buildStudioShellUrl } from '@/features/prisma-studio/studio-url';
import { getApiBaseUrl } from '@/lib/api-config';
import { requireSuperAdmin } from '@/lib/route-guards';
import { useAuthStore } from '@/store/auth-store';

export const Route = createFileRoute('/_authenticated/prisma-studio')({
  beforeLoad: ({ context }) => requireSuperAdmin(context),
  component: PrismaStudioPage,
});

/**
 * TASK-403 — Prisma Studio (OPERATIONS nav, design §2 taxonomy; no dedicated
 * §5 frame — the Studio shell itself is the dev-only API-served page). This
 * surface is a **status card + link-out only**: the always-on status probe
 * reports whether the shell is enabled, and the link opens it in a new tab
 * with the bearer passed via the URL fragment (TASK-336 OB-11). No raw DB
 * access is proxied through this console.
 */
function PrismaStudioPage() {
  const { status, isLoading, error, refreshStatus } = usePrismaStudio();
  const accessToken = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    void refreshStatus().catch(() => undefined);
  }, [refreshStatus]);

  const openStudio = () => {
    window.open(buildStudioShellUrl(getApiBaseUrl(), accessToken), '_blank', 'noopener');
  };

  return (
    <div>
      <PageHeader title="Prisma Studio" description="Privileged database browser — dev-only, audited, super-admin only." />

      {error ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn’t read the Studio status</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="max-w-2xl gap-4 p-6" data-testid="pstudio-status-card">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md border bg-muted/40">
              <Database className="size-5 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Prisma Studio shell</h3>
              <p className="text-xs text-muted-foreground">Served by the API gateway at /admin/pstudio</p>
            </div>
          </div>
          {isLoading && !status ? (
            <div className="h-5 w-20 animate-pulse rounded bg-muted" />
          ) : (
            <StatusBadge label={status?.enabled ? 'Available' : 'Disabled'} colorRole={status?.enabled ? 'success' : 'neutral'} />
          )}
        </div>

        {status?.enabled ? (
          <>
            <p className="text-sm text-muted-foreground">
              Studio opens in a new tab. Your session token is passed via the URL fragment (never sent to the server) and scrubbed from history on
              load. Every raw query is audited.
            </p>
            <div>
              <Button onClick={openStudio}>
                <ExternalLink className="size-4" />
                Open Prisma Studio
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Prisma Studio is <span className="font-medium text-foreground">off in this environment</span>. It is a fail-closed dev-only tool: the API
            only serves it when <span className="font-mono text-xs">NODE_ENV=development</span> and{' '}
            <span className="font-mono text-xs">ENABLE_PRISMA_STUDIO=true</span> are both set — it can never surface in staging or production.
          </p>
        )}
      </Card>

      <p className="mt-4 max-w-2xl text-xs text-muted-foreground">
        Access requires the <span className="font-mono">manage all</span> permission (super-admin). This console never proxies raw database access —
        the shell talks to its own audited backend-for-frontend endpoint.
      </p>
    </div>
  );
}
