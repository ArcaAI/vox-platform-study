import { Button } from '@arcaai/ui/button';
import { Separator } from '@arcaai/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@arcaai/ui/sheet';
import { Spinner } from '@arcaai/ui/spinner';
import { StatusBadge } from '@arcaai/ui/components/shared';
import type { Tenant } from '@arcaai/vox';
import { Pencil, Power, PowerOff, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { resourceStatusLabel, resourceStatusRole } from '@/features/data-grid/status';

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="grid grid-cols-3 gap-2 py-1.5 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className="col-span-2 min-w-0 wrap-break-word">{children}</span>
        </div>
    );
}

function hasConfig(configs: unknown): boolean {
    if (!configs) return false;
    if (Array.isArray(configs)) return configs.length > 0;
    return typeof configs === 'object' && Object.keys(configs as object).length > 0;
}

/**
 * Read-only tenant detail drawer (TASK-374) with edit / enable-disable actions.
 * The system tenant is protected (DEF-ADM-001): edit + disable are blocked
 * client-side (the server is the final authority).
 */
export function TenantDetailSheet({
    tenant,
    open,
    onOpenChange,
    isSystem,
    isMutating,
    onEdit,
    onToggleStatus,
    loadConfigs,
}: {
    tenant: Tenant | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    isSystem: boolean;
    isMutating: boolean;
    onEdit: (tenant: Tenant) => void;
    onToggleStatus: (tenant: Tenant) => void;
    loadConfigs: (id: string) => Promise<unknown>;
}) {
    const [configs, setConfigs] = useState<unknown>(undefined);
    const [configError, setConfigError] = useState<string | null>(null);
    const [loadingConfigs, setLoadingConfigs] = useState(false);

    const tenantId = tenant?.id;
    useEffect(() => {
        if (!open || !tenantId) return;
        let cancelled = false;
        setConfigs(undefined);
        setConfigError(null);
        setLoadingConfigs(true);
        loadConfigs(tenantId)
            .then((c) => {
                if (!cancelled) setConfigs(c);
            })
            .catch((e) => {
                if (!cancelled) setConfigError(e instanceof Error ? e.message : String(e));
            })
            .finally(() => {
                if (!cancelled) setLoadingConfigs(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, tenantId, loadConfigs]);

    const status = tenant?.resourceStatus;
    const isEnabled = String(status ?? '').toUpperCase() === 'ENABLED';

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-lg">
                <SheetHeader>
                    <SheetTitle className="flex items-center gap-2">
                        {tenant?.name ?? 'Tenant'}
                        {isSystem ? <StatusBadge label="System" colorRole="hope" icon={<ShieldCheck />} /> : null}
                    </SheetTitle>
                    <SheetDescription>Organization details and configuration.</SheetDescription>
                </SheetHeader>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
                    {tenant ? (
                        <div className="divide-y">
                            <DetailRow label="Status">
                                <StatusBadge label={resourceStatusLabel(status)} colorRole={resourceStatusRole(status)} />
                            </DetailRow>
                            <DetailRow label="Key">
                                <span className="font-mono text-xs">{String(tenant.key ?? '—')}</span>
                            </DetailRow>
                            <DetailRow label="ID">
                                <span className="font-mono text-xs text-muted-foreground">{tenant.id}</span>
                            </DetailRow>
                            <DetailRow label="Description">{tenant.description || <span className="text-muted-foreground">—</span>}</DetailRow>
                        </div>
                    ) : null}

                    <Separator className="my-4" />
                    <p className="mb-2 text-sm font-medium">Configuration</p>
                    {loadingConfigs ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner className="size-4" />
                            Loading…
                        </div>
                    ) : configError ? (
                        <p className="text-sm text-muted-foreground">Configuration unavailable: {configError}</p>
                    ) : hasConfig(configs) ? (
                        <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">{JSON.stringify(configs, null, 2)}</pre>
                    ) : (
                        <p className="text-sm text-muted-foreground">No configuration set.</p>
                    )}
                </div>

                <SheetFooter>
                    {tenant ? (
                        <div className="flex w-full flex-wrap items-center gap-2">
                            <Button variant="outline" onClick={() => onEdit(tenant)} disabled={isSystem}>
                                <Pencil className="size-4" />
                                Edit
                            </Button>
                            <Button
                                variant={isEnabled ? 'outline' : 'default'}
                                onClick={() => onToggleStatus(tenant)}
                                disabled={isSystem || isMutating}
                                title={isSystem ? 'The system tenant cannot be disabled' : undefined}
                            >
                                {isMutating ? <Spinner className="size-4" /> : isEnabled ? <PowerOff className="size-4" /> : <Power className="size-4" />}
                                {isEnabled ? 'Disable' : 'Enable'}
                            </Button>
                        </div>
                    ) : null}
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
}
