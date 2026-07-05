'use client';

import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { GatewayError } from '@/shared/api';

/**
 * Optimistic-concurrency error strip (frame 08): 412 Precondition Failed
 * offers reload (edits kept by the caller) and optional overwrite; 428
 * Precondition Required signals a stale tab / client bug — refresh.
 * Renders nothing for other errors (the form's own error handling applies).
 */
export function OccConflictAlert({ error, onReload, onOverwrite }: { error: unknown; onReload: () => void; onOverwrite?: () => void }) {
    if (!(error instanceof GatewayError)) return null;

    if (error.isVersionConflict) {
        return (
            <Alert variant="destructive">
                <IconAlertTriangle aria-hidden />
                <AlertTitle>412 Precondition Failed — changed by another admin after you loaded it</AlertTitle>
                <AlertDescription>
                    <p>Your unsaved edits are kept locally. Compare before overwriting.</p>
                    <div className="mt-2 flex gap-2">
                        <Button variant="outline" size="sm" onClick={onReload}>
                            Reload latest
                        </Button>
                        {onOverwrite ? (
                            <Button variant="destructive" size="sm" onClick={onOverwrite}>
                                Overwrite anyway
                            </Button>
                        ) : null}
                    </div>
                </AlertDescription>
            </Alert>
        );
    }

    if (error.isMissingPrecondition) {
        return (
            <Alert>
                <IconInfoCircle aria-hidden />
                <AlertTitle>428 Precondition Required</AlertTitle>
                <AlertDescription>
                    The request was sent without If-Match. The console always includes it — seeing this means a stale tab. Refresh the page.
                </AlertDescription>
            </Alert>
        );
    }

    return null;
}
