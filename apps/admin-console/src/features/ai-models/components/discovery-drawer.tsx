'use client';

import { useState } from 'react';
import { IconAlertTriangle, IconPlus, IconRefresh, IconServerOff } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { useModelDiscovery, useRegisterDiscoveredModel } from '../api/hooks';
import type { DiscoveryEntry, DiscoveryEntryStatus, DiscoveryLoadState, DiscoveryProbe } from '../api/types';

/**
 * The discovery half of the AI-models hub.
 *
 * Shows every model either side of the merge knows about, tagged against the
 * registry, with the engine's load state where the engine reports it. It is
 * strictly READ-ONLY except for the explicit per-row Register action: a model
 * running on a server does NOT enter governance until an admin says so, and a
 * failed probe never removes or disables a registry row (§3.2).
 *
 * Probes are lazy — the query is gated on `open`, so the registry grid behind
 * this drawer never waits on an engine round-trip.
 */

/** Never colour alone (rule 11 §10): each tag carries its own label. */
const STATUS_META: Record<DiscoveryEntryStatus, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
    registered: { label: 'Registered', variant: 'outline' },
    discovered: { label: 'Discovered', variant: 'secondary' },
    'registered-missing-on-server': { label: 'Missing on server', variant: 'destructive' },
};

const LOAD_STATE_LABEL: Record<DiscoveryLoadState, string> = {
    loaded: 'Loaded',
    'not-loaded': 'Not loaded',
    unknown: 'Load state unknown',
};

function ProbeLine({ probe }: { probe: DiscoveryProbe }) {
    const ok = probe.probeStatus === 'ok';
    return (
        <li className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline" className="font-mono">
                {probe.provider}
            </Badge>
            <span className={ok ? 'text-muted-foreground' : 'text-destructive'}>
                {ok ? 'Reachable' : `Probe ${probe.probeStatus}`}
            </span>
            {typeof probe.latencyMs === 'number' ? <span className="text-muted-foreground text-xs">{probe.latencyMs} ms</span> : null}
            {probe.error ? <span className="text-muted-foreground text-xs">{probe.error}</span> : null}
        </li>
    );
}

function EntryRow({
    entry,
    onRegister,
    isRegistering,
}: {
    entry: DiscoveryEntry;
    onRegister: () => void;
    isRegistering: boolean;
}) {
    const status = STATUS_META[entry.status];
    const quantization = typeof entry.engineMeta?.['quantization'] === 'string' ? (entry.engineMeta['quantization'] as string) : null;
    const maxContext =
        typeof entry.engineMeta?.['max_context_length'] === 'number' ? (entry.engineMeta['max_context_length'] as number) : null;

    return (
        <li className="flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0">
            <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate font-mono text-sm">{entry.modelName}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="font-mono">
                        {entry.provider}
                    </Badge>
                    <Badge variant={status.variant}>{status.label}</Badge>
                    <Badge variant="outline">{LOAD_STATE_LABEL[entry.loadState]}</Badge>
                    {quantization ? <span className="text-muted-foreground font-mono text-xs">{quantization}</span> : null}
                    {maxContext ? <span className="text-muted-foreground font-mono text-xs">{maxContext} ctx</span> : null}
                </span>
            </div>
            {entry.status === 'discovered' ? (
                <Button size="sm" onClick={onRegister} disabled={isRegistering} aria-label={`Register ${entry.modelName}`}>
                    {isRegistering ? <Spinner /> : <IconPlus aria-hidden />}
                    Register
                </Button>
            ) : (
                <span className="text-muted-foreground font-mono text-xs">{entry.registeredModel?.slug}</span>
            )}
        </li>
    );
}

function LoadingSkeleton() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-36 rounded-full" />
                <Skeleton className="h-5 w-44 rounded-full" />
            </div>
            <div className="flex flex-col gap-3">
                {[0, 1, 2, 3].map((row) => (
                    <div key={row} className="flex items-center justify-between gap-3">
                        <div className="flex flex-col gap-2">
                            <Skeleton className="h-4 w-56" />
                            <Skeleton className="h-5 w-40 rounded-full" />
                        </div>
                        <Skeleton className="h-8 w-24" />
                    </div>
                ))}
            </div>
        </div>
    );
}

export interface DiscoveryDrawerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function DiscoveryDrawer({ open, onOpenChange }: DiscoveryDrawerProps) {
    const { data, isLoading, isFetching, error, refetch } = useModelDiscovery(undefined, open);
    const registerMutation = useRegisterDiscoveredModel();
    const [pending, setPending] = useState<string | null>(null);

    function handleRegister(entry: DiscoveryEntry) {
        setPending(`${entry.provider} ${entry.modelName}`);
        registerMutation.mutate(
            { provider: entry.provider, modelName: entry.modelName },
            {
                onSuccess: () => {
                    toast.success(`${entry.modelName} registered`);
                    setPending(null);
                },
                onError: (err) => {
                    toast.error(err.message);
                    setPending(null);
                },
            },
        );
    }

    return (
        <DetailDrawer
            open={open}
            onOpenChange={onOpenChange}
            size="lg"
            title="Discover models from servers"
            meta={
                data ? (
                    <>
                        <span data-testid="discovery-probed-at">Probed {formatRelativeTime(data.probedAt)}</span>
                        <span>&middot;</span>
                        <span>{data.entries.length} models</span>
                    </>
                ) : null
            }
            footer={
                <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
                    {isFetching ? <Spinner /> : <IconRefresh aria-hidden />}
                    Refresh
                </Button>
            }
        >
            {isLoading ? (
                <LoadingSkeleton />
            ) : error ? (
                <EmptyState
                    icon={IconAlertTriangle}
                    title="Couldn't reach the discovery service"
                    description={error.message}
                    action={
                        <Button variant="outline" onClick={() => void refetch()}>
                            <IconRefresh aria-hidden />
                            Retry
                        </Button>
                    }
                />
            ) : !data || data.entries.length === 0 ? (
                <EmptyState
                    icon={IconServerOff}
                    title="No models found on any server"
                    description="No reachable engine reported a model, and no registry row targets a server-managed provider."
                />
            ) : (
                <div className="flex flex-col gap-5">
                    <section className="flex flex-col gap-2">
                        <h3 className="text-sm font-medium">Server probes</h3>
                        {data.probes.length > 0 ? (
                            <ul className="flex flex-col gap-1.5">
                                {data.probes.map((probe) => (
                                    <ProbeLine key={probe.provider} probe={probe} />
                                ))}
                            </ul>
                        ) : (
                            <p className="text-muted-foreground text-sm">No server-managed provider is configured.</p>
                        )}
                    </section>
                    <section className="flex flex-col gap-1">
                        <h3 className="text-sm font-medium">Models ({data.entries.length})</h3>
                        <ul className="flex flex-col">
                            {data.entries.map((entry) => (
                                <EntryRow
                                    key={`${entry.provider}:${entry.modelName}`}
                                    entry={entry}
                                    onRegister={() => handleRegister(entry)}
                                    isRegistering={pending === `${entry.provider} ${entry.modelName}`}
                                />
                            ))}
                        </ul>
                    </section>
                </div>
            )}
        </DetailDrawer>
    );
}
