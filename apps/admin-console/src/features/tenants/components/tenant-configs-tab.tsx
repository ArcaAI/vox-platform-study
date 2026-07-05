'use client';

import { useState } from 'react';
import { IconAdjustmentsHorizontal, IconLock } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useTenantConfigs, useUpdateTenantConfigs } from '../api/hooks';
import type { TenantConfig } from '../api/types';

function isOccError(error: unknown): boolean {
    return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/**
 * Frame 12.1 configs tab: per-row inline value editing over the bulk PATCH —
 * each save sends one row with its own expectedVersion (all-or-nothing 412).
 */
export function TenantConfigsTab({ id }: { id: string }) {
    const { data, isLoading, error, refetch } = useTenantConfigs(id, { page: 0, limit: 100 });
    const update = useUpdateTenantConfigs();
    const [drafts, setDrafts] = useState<Record<string, string>>({});

    if (isLoading) {
        return (
            <Card className="gap-4 p-6">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
            </Card>
        );
    }
    if (error || !data) {
        return <ErrorState error={error} onRetry={() => refetch()} />;
    }

    const rows = data.data;

    function save(config: TenantConfig) {
        const value = drafts[config.id];
        if (value === undefined) return;
        update.mutate(
            { identifier: id, updates: [{ id: config.id, value, expectedVersion: config.version }] },
            {
                onSuccess: () => {
                    toast.success(`${config.key} updated`);
                    setDrafts(({ [config.id]: _saved, ...rest }) => rest);
                },
                onError: (mutationError) => {
                    if (!isOccError(mutationError)) {
                        toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not update the config.');
                    }
                },
            },
        );
    }

    if (rows.length === 0) {
        return <EmptyState icon={IconAdjustmentsHorizontal} title="No configs for this tenant" description="Platform defaults apply until a config row is created." />;
    }

    return (
        <div className="flex flex-col gap-4">
            <OccConflictAlert
                error={update.error}
                onReload={() => {
                    update.reset();
                    setDrafts({});
                    refetch();
                }}
            />
            <Card className="gap-0 divide-y p-0">
                {rows.map((config) => {
                    const draft = drafts[config.id];
                    const dirty = draft !== undefined && draft !== config.value;
                    return (
                        <div key={config.id} className="flex flex-wrap items-center gap-3 p-4">
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium">{config.name}</span>
                                    {config.namespace ? <span className="text-muted-foreground text-xs">{config.namespace}</span> : null}
                                    {config.locked ? (
                                        <Badge variant="outline">
                                            <IconLock aria-hidden />
                                            Locked
                                        </Badge>
                                    ) : null}
                                </div>
                                <div className="text-muted-foreground font-mono text-xs">{config.key}</div>
                                {config.description ? <p className="text-muted-foreground mt-1 text-xs">{config.description}</p> : null}
                            </div>
                            <div className="flex items-center gap-2">
                                <Input
                                    aria-label={`Value for ${config.key}`}
                                    value={draft ?? config.value}
                                    onChange={(event) => setDrafts((current) => ({ ...current, [config.id]: event.target.value }))}
                                    disabled={config.locked}
                                    className="h-8 w-56 font-mono text-xs"
                                />
                                <Button
                                    size="sm"
                                    variant="outline"
                                    aria-label={`Save ${config.key}`}
                                    disabled={!dirty || update.isPending}
                                    onClick={() => save(config)}
                                >
                                    Save
                                </Button>
                            </div>
                        </div>
                    );
                })}
            </Card>
        </div>
    );
}
