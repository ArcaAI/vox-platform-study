'use client';

import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { GatewayError } from '@/shared/api';

function errorTitle(error: unknown, fallback: string): string {
    if (error instanceof GatewayError) {
        if (error.isNotFound) return 'Not found';
        if (error.isUnauthorized) return 'Session expired';
    }
    return fallback;
}

function errorDescription(error: unknown): string {
    if (error instanceof GatewayError && error.isNotFound) {
        // 404-over-403 tenancy posture: "not yours" and "missing" are the same.
        return 'This resource does not exist or is outside your tenant scope.';
    }
    if (error instanceof Error && error.message) return error.message;
    return 'The request failed. The data shown may be stale.';
}

/**
 * Block error state per the 09 template: destructive-bordered card with the
 * failure detail and a retry action. Used when a screen has NO data to show.
 */
export function ErrorState({ title = 'Couldn\u2019t load this data', error, onRetry }: { title?: string; error: unknown; onRetry?: () => void }) {
    return (
        <Card role="alert" className="border-destructive/40 flex flex-col items-center gap-3 p-10 text-center">
            <IconAlertTriangle aria-hidden className="text-destructive size-8" />
            <div className="flex flex-col gap-1">
                <p className="text-destructive font-medium">{errorTitle(error, title)}</p>
                <p className="text-muted-foreground text-sm">{errorDescription(error)}</p>
            </div>
            {onRetry ? (
                <Button variant="outline" size="sm" onClick={onRetry}>
                    <IconRefresh aria-hidden />
                    Retry
                </Button>
            ) : null}
        </Card>
    );
}

/**
 * Inline error banner per the list frames' error variant: when a refetch
 * fails but stale rows are still on screen, keep them and flag staleness.
 */
export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
    return (
        <div role="alert" className="border-destructive/40 bg-destructive/10 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <IconAlertTriangle aria-hidden className="text-destructive size-4 shrink-0" />
            <span className="text-destructive min-w-0 flex-1 truncate">
                {errorDescription(error)} <span className="text-muted-foreground">(showing last loaded data)</span>
            </span>
            {onRetry ? (
                <Button variant="ghost" size="sm" onClick={onRetry} className="shrink-0">
                    <IconRefresh aria-hidden />
                    Retry
                </Button>
            ) : null}
        </div>
    );
}
