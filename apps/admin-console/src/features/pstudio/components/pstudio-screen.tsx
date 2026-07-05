'use client';

import { IconAlertTriangle, IconDatabaseOff, IconExternalLink } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { usePstudioStatus } from '../api/hooks';

/**
 * The status payload only proves enablement, so the embed target is the
 * BFF-proxied gateway shell (GET /admin/pstudio serves the studio HTML behind
 * the session guard — same path the api client uses, minus /status).
 */
const STUDIO_SRC = '/api/hope/admin/pstudio';

const SURFACE_CLASS = 'min-h-[70vh] w-full rounded-md border';

function StudioSurface() {
    return (
        <div className="flex flex-col gap-3">
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
            <iframe title="Prisma Studio" src={STUDIO_SRC} sandbox="allow-scripts allow-same-origin allow-forms" className={`${SURFACE_CLASS} bg-card`} />
        </div>
    );
}

function DisabledCard() {
    return (
        <Card className="min-h-[70vh] w-full justify-center">
            <EmptyState
                icon={IconDatabaseOff}
                title="Prisma Studio is disabled"
                description={
                    <>
                        The studio shell is off in this environment (fail-closed). The gateway enables it only when both{' '}
                        <code className="font-mono">NODE_ENV=development</code> and <code className="font-mono">ENABLE_PRISMA_STUDIO=true</code> are
                        set — production enablement behind a dedicated permission is tracked in TASK-419. No broken iframe is shown.
                    </>
                }
            />
        </Card>
    );
}

function LoadingSurface() {
    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-8 w-36" />
            </div>
            <Skeleton className={SURFACE_CLASS} />
        </div>
    );
}

/**
 * Frame 19 — Prisma Studio: truthful enabled/disabled surface from
 * GET /admin/pstudio/status; the iframe shell renders only when the gateway
 * confirms the studio module is registered.
 */
export function PstudioScreen() {
    const statusQuery = usePstudioStatus();

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Prisma Studio"
                meta={
                    <>
                        <span>Embedded database browser</span>
                        <span aria-hidden>&middot;</span>
                        <span>GlobalAdmin only</span>
                        <span aria-hidden>&middot;</span>
                        <span className="font-mono text-xs">session-guarded proxy {STUDIO_SRC}</span>
                    </>
                }
            />
            <Alert>
                <IconAlertTriangle aria-hidden />
                <AlertTitle>Production data</AlertTitle>
                <AlertDescription>
                    Every write here bypasses domain rules and is audit-logged. Prefer admin screens for routine edits.
                </AlertDescription>
            </Alert>
            {statusQuery.isLoading ? (
                <LoadingSurface />
            ) : statusQuery.error ? (
                <ErrorState error={statusQuery.error} onRetry={() => void statusQuery.refetch()} />
            ) : statusQuery.data?.enabled ? (
                <StudioSurface />
            ) : (
                <DisabledCard />
            )}
        </div>
    );
}
