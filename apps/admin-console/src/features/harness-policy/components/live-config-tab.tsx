'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { formatRelativeTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useLiveDocConfig, useUpdateLiveDocConfig } from '../api';

/**
 * Live config tab (frame 36): the live-documentation engine kill-switch.
 * VERIFIED contract deviation from the frame's "max sessions · stage
 * timeouts" annotation — LiveDocEngineConfigResponse carries only the
 * enabled flag (+ env default/source metadata) and the PATCH is a plain,
 * non-OCC toggle (UpdateLiveDocEngineConfigRequest: enabled + reason).
 * The gateway asserts platform admin in code, so this tab only mounts for
 * elevated sessions.
 */
export function LiveConfigTab() {
    const uid = useId();
    const configQuery = useLiveDocConfig(true);
    const updateMutation = useUpdateLiveDocConfig();
    const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
    const [reason, setReason] = useState('');

    if (configQuery.isPending) {
        return (
            <Card className="gap-4 p-6" aria-hidden>
                <Skeleton className="h-5 w-56" />
                <Skeleton className="h-8 w-full max-w-md" />
                <Skeleton className="h-9 w-full max-w-md" />
            </Card>
        );
    }
    if (configQuery.error || !configQuery.data) {
        return <ErrorState error={configQuery.error} onRetry={() => void configQuery.refetch()} />;
    }

    const config = configQuery.data;
    const enabled = enabledDraft ?? config.enabled;
    const dirty = enabled !== config.enabled;

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!dirty) return;
        const trimmedReason = reason.trim();
        updateMutation.mutate(
            { enabled, ...(trimmedReason ? { reason: trimmedReason } : {}) },
            {
                onSuccess: (next) => {
                    toast.success(next.enabled ? 'Live documentation engine enabled' : 'Kill-switch engaged \u2014 in-flight sessions drain');
                    setEnabledDraft(null);
                    setReason('');
                },
                onError: (error) => toast.error(error.message),
            },
        );
    }

    return (
        <Card className="max-w-2xl gap-4 p-6">
            <div className="flex flex-col gap-1">
                <h2 className="text-base font-semibold">Live documentation engine</h2>
                <p className="text-muted-foreground text-sm">
                    Runtime kill-switch (super-admin, global scope). <span className="font-mono text-xs">PATCH /admin/harness/live/config</span> persists
                    a Redis override that fans out to all API instances &mdash; no redeploy. Disabling refuses new sessions while in-flight ones drain.
                </p>
            </div>
            <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="outline" className="font-mono text-[10px]">
                    env default: {config.envDefault ? 'enabled' : 'disabled'}
                </Badge>
                <Badge variant="outline" className="font-mono text-[10px]">
                    source: {config.source}
                </Badge>
                {config.updatedAt ? <span>overridden {formatRelativeTime(config.updatedAt)}</span> : null}
            </div>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                    <Switch id={`${uid}-enabled`} checked={enabled} onCheckedChange={(next) => setEnabledDraft(next)} />
                    <Label htmlFor={`${uid}-enabled`}>{enabled ? 'Engine enabled' : 'Engine disabled (kill-switch engaged)'}</Label>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${uid}-reason`} className="text-muted-foreground text-xs font-medium">
                        Audit reason
                    </Label>
                    <Input
                        id={`${uid}-reason`}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        maxLength={500}
                        placeholder={'Why toggle the engine\u2026'}
                    />
                </div>
                <div className="flex flex-wrap items-center justify-end gap-3">
                    {dirty ? <span className="text-muted-foreground text-sm">Unsaved changes</span> : null}
                    <Button type="submit" disabled={!dirty || updateMutation.isPending}>
                        {updateMutation.isPending ? <Spinner /> : null}
                        Save live config
                    </Button>
                </div>
            </form>
        </Card>
    );
}
