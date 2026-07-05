'use client';

import { useState } from 'react';
import { IconBan, IconBolt, IconX } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { useCancelWorkflow, useTerminateWorkflow } from '../api';
import { LiveSessionsCard } from './live-sessions-card';
import { SignalDialog } from './signal-dialog';

type LifecycleAction = 'signal' | 'cancel' | 'terminate';

/**
 * Frame 38 panel (c) — lifecycle controls for the selected workflow (signal /
 * cancel / terminate, each behind its own confirmation posture) plus the live
 * sessions monitor.
 */
export function SignalsLifecyclePanel({ workflowId }: { workflowId: string | null }) {
    const cancel = useCancelWorkflow();
    const terminate = useTerminateWorkflow();
    const [action, setAction] = useState<LifecycleAction | null>(null);

    function handleCancelConfirmed() {
        if (!workflowId) return;
        cancel.mutate(
            { workflowId },
            {
                onSuccess: () => {
                    toast.success(`Cancellation requested for ${workflowId}`);
                    setAction(null);
                },
                onError: (error) => {
                    toast.error(error instanceof GatewayError ? error.message : 'Could not cancel the workflow.');
                    setAction(null);
                },
            },
        );
    }

    function handleTerminateConfirmed() {
        if (!workflowId) return;
        terminate.mutate(
            { workflowId },
            {
                onSuccess: () => {
                    toast.success(`${workflowId} terminated`);
                    setAction(null);
                },
                onError: (error) => {
                    toast.error(error instanceof GatewayError ? error.message : 'Could not terminate the workflow.');
                    setAction(null);
                },
            },
        );
    }

    return (
        <Card className="gap-3 py-4">
            <CardHeader className="gap-1 px-4">
                <h2 className="text-sm font-medium">Signals &amp; lifecycle</h2>
                <span aria-hidden className="text-muted-foreground font-mono text-xs">
                    POST workflows/:id/{'{signal,cancel,terminate}'}
                </span>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-4">
                {workflowId ? (
                    <p className="text-sm">
                        Selected: <span className="font-mono text-xs break-all">{workflowId}</span>
                    </p>
                ) : (
                    <p className="text-muted-foreground text-sm">Select a workflow from the grid to enable lifecycle actions.</p>
                )}
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" disabled={!workflowId} onClick={() => setAction('signal')}>
                        <IconBolt aria-hidden />
                        Signal
                    </Button>
                    <Button variant="outline" size="sm" disabled={!workflowId} onClick={() => setAction('cancel')}>
                        <IconBan aria-hidden />
                        Cancel
                    </Button>
                    <Button variant="destructive" size="sm" disabled={!workflowId} onClick={() => setAction('terminate')}>
                        <IconX aria-hidden />
                        Terminate
                    </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                    Signal delivers to a running workflow {'\u00b7'} cancel unwinds gracefully {'\u00b7'} terminate is forceful and
                    type-to-confirm.
                </p>
                <LiveSessionsCard />
            </CardContent>
            <SignalDialog workflowId={workflowId} open={action === 'signal'} onOpenChange={(open) => setAction(open ? 'signal' : null)} />
            <ConfirmDialog
                open={action === 'cancel'}
                onOpenChange={(open) => setAction(open ? 'cancel' : null)}
                title="Cancel workflow?"
                description={`Requests a graceful Temporal cancellation for ${workflowId ?? ''}. In-flight activities finish before the workflow unwinds.`}
                confirmLabel="Cancel workflow"
                isPending={cancel.isPending}
                onConfirm={handleCancelConfirmed}
            />
            <ConfirmDialog
                open={action === 'terminate'}
                onOpenChange={(open) => setAction(open ? 'terminate' : null)}
                title="Terminate workflow?"
                description={`Forcefully terminates ${workflowId ?? ''} with no cleanup — running activities are abandoned. This cannot be undone.`}
                confirmLabel="Terminate workflow"
                destructive
                typeToConfirm={workflowId ?? undefined}
                isPending={terminate.isPending}
                onConfirm={handleTerminateConfirmed}
            />
        </Card>
    );
}
