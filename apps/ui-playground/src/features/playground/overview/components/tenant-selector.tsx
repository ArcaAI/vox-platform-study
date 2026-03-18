import { useCallback, useEffect, useState } from 'react';
import { useTenants, type Tenant } from '@arcaai/vox';
import { useAuthStore } from '@/store/auth-store';
import { Button } from '@arcaai/ui/button';
import { Badge } from '@arcaai/ui/badge';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@arcaai/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Building2, Check, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

export function TenantSelector() {
    const { tenantId, setTenant, isSuperAdmin } = useAuthStore();
    const { tenants, isLoading, list } = useTenants();
    const [selectedId, setSelectedId] = useState<string>('');

    const isSA = isSuperAdmin();
    const hasTenant = !!tenantId;

    const fetchTenants = useCallback(async () => {
        try {
            await list({ page: 1, limit: 100 });
        } catch {
            // tenant list may fail without tenant context — expected for super_admin
        }
    }, [list]);

    useEffect(() => {
        if (isSA) fetchTenants();
    }, [isSA, fetchTenants]);

    useEffect(() => {
        if (tenantId && tenants.length > 0) {
            const match = tenants.find((t) => t.id === tenantId);
            if (match) setSelectedId(match.id);
        }
    }, [tenantId, tenants]);

    if (isSA && isLoading && tenants.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <div className="flex items-center gap-2">
                        <Skeleton className="size-5 rounded" />
                        <Skeleton className="h-5 w-28" />
                        <Skeleton className="h-5 w-20 rounded-full" />
                    </div>
                    <Skeleton className="mt-2 h-4 w-3/4" />
                </CardHeader>
                <CardContent>
                    <div className="flex items-end gap-3">
                        <div className="flex flex-1 flex-col gap-1.5">
                            <Skeleton className="h-4 w-12" />
                            <Skeleton className="h-9 w-full rounded-md" />
                        </div>
                        <Skeleton className="h-9 w-16 rounded-md" />
                    </div>
                </CardContent>
            </Card>
        );
    }

    if (!isSA) return null;

    const activeTenant = tenants.find((t) => t.id === tenantId);

    const handleApply = () => {
        if (!selectedId) return;
        const tenant = tenants.find((t) => t.id === selectedId);
        if (tenant) {
            setTenant(tenant.id, tenant.name);
            toast.success(`Switched to tenant: ${tenant.name}`);
        }
    };

    const handleClear = () => {
        setTenant('', '');
        setSelectedId('');
        toast.info('Tenant context cleared');
    };

    return (
        <Card className={!hasTenant ? 'border-amber-500/50' : undefined}>
            <CardHeader>
                <div className="flex items-center gap-2">
                    <Building2 className="size-5" />
                    <CardTitle className="text-base">Tenant Context</CardTitle>
                    {hasTenant && activeTenant ? (
                        <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                            {activeTenant.name}
                        </Badge>
                    ) : (
                        <Badge variant="outline" className="bg-amber-500/15 text-amber-700 dark:text-amber-400">
                            No tenant selected
                        </Badge>
                    )}
                </div>
                <CardDescription>
                    {hasTenant
                        ? 'Playground operations are scoped to the selected tenant.'
                        : 'Select a tenant to use playground features like consultations and audio.'}
                </CardDescription>
            </CardHeader>
            <CardContent>
                {!hasTenant && (
                    <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                        <p className="text-sm text-amber-700 dark:text-amber-400">
                            As a Super Admin, you don&apos;t have a default tenant.
                            Select one below or impersonate a tenant user from the User Impersonation table.
                        </p>
                    </div>
                )}

                <div className="flex items-end gap-3">
                    <div className="flex-1 space-y-1.5">
                        <label className="text-sm font-medium">Tenant</label>
                        <Select
                            value={selectedId}
                            onValueChange={setSelectedId}
                            disabled={isLoading}
                        >
                            <SelectTrigger>
                                <SelectValue placeholder={isLoading ? 'Loading tenants...' : 'Select a tenant'} />
                            </SelectTrigger>
                            <SelectContent>
                                {tenants
                                    .filter((t: Tenant) => t.resourceStatus !== 'DISABLED')
                                    .map((t: Tenant) => (
                                        <SelectItem key={t.id} value={t.id}>
                                            <div className="flex items-center gap-2">
                                                {t.name}
                                                {t.key && (
                                                    <span className="text-muted-foreground text-xs">
                                                        ({t.key})
                                                    </span>
                                                )}
                                                {t.id === tenantId && (
                                                    <Check className="size-3.5 text-emerald-600" />
                                                )}
                                            </div>
                                        </SelectItem>
                                    ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <Button
                        onClick={handleApply}
                        disabled={!selectedId || selectedId === activeTenant?.id}
                    >
                        Apply
                    </Button>
                    {hasTenant && (
                        <Button variant="outline" onClick={handleClear}>
                            Clear
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
