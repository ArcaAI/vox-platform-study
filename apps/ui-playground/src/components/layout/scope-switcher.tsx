import { useState } from 'react';
import { useAdminTenants, type Tenant } from '@/features/admin/api/tenants';
import { useAuthStore } from '@/store/auth-store';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@arcaai/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@arcaai/ui/popover';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/tooltip';
import { Building2, Check, ChevronsUpDown, Lock } from 'lucide-react';
import { toast } from 'sonner';

/**
 * ScopeSwitcher — TASK-327 T4.
 *
 * Header control that materialises the scope model (D1):
 *  - Global scope (SUPER_ADMIN): a searchable tenant picker.
 *    Picking a tenant sets the active tenant (store `setTenant`), which the
 *    SDK + ScopeSyncInit already react to. Tenant list is served from the
 *    cached `useAdminTenants` React Query hook so it isn't refetched on every
 *    mount; it is only enabled for global scope.
 *  - TENANT_ADMIN (locked to their own tenant): a non-interactive badge with
 *    a tooltip explaining the lock.
 */
export function ScopeSwitcher() {
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());
  const tenantId = useAuthStore((s) => s.tenantId);
  const tenantName = useAuthStore((s) => s.tenantName);
  const tenantKey = useAuthStore((s) => s.tenantKey);
  const setTenant = useAuthStore((s) => s.setTenant);
  const [open, setOpen] = useState(false);

  // Only global-scope operators may switch tenants, so the cross-tenant list
  // is only fetched for them (`enabled`). Rules-of-hooks: the hook is always
  // called; the request is what's gated.
  const { data, isLoading } = useAdminTenants({ page: 1, limit: 100 }, { enabled: isGlobalScope, staleTime: 5 * 60 * 1000 });
  const tenants = data?.data ?? [];

  const displayName = tenantName || tenantKey || (tenantId ? `${tenantId.slice(0, 8)}\u2026` : '');

  // ── TENANT_ADMIN — locked to their own tenant ──────────────────────
  if (!isGlobalScope) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="cursor-default gap-1.5">
              <Lock className="size-3" />
              <Building2 className="size-3.5" />
              {displayName || 'No tenant'}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end">
            Scoped to your tenant
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // ── Global scope — interactive tenant picker ───────────────────────
  const handleSelect = (tenant: Tenant) => {
    setTenant(tenant.id, tenant.name);
    toast.success(`Switched to tenant: ${tenant.name}`);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" role="combobox" aria-expanded={open} className="gap-1.5">
          <Building2 className="size-3.5" />
          <span className="max-w-40 truncate">{tenantId ? displayName : 'Select tenant'}</span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search tenants..." />
          <CommandList>
            {isLoading ? (
              <div className="flex flex-col gap-1 p-2">
                <Skeleton className="h-8 w-full rounded-md" />
                <Skeleton className="h-8 w-full rounded-md" />
                <Skeleton className="h-8 w-full rounded-md" />
              </div>
            ) : (
              <>
                <CommandEmpty>No tenants found.</CommandEmpty>
                <CommandGroup>
                  {tenants
                    .filter((t) => t.resourceStatus !== 'DISABLED')
                    .map((t) => (
                      <CommandItem key={t.id} value={`${t.name} ${t.key}`} onSelect={() => handleSelect(t)} className="gap-2">
                        <Building2 className="size-3.5 shrink-0" />
                        <span className="flex-1 truncate">{t.name}</span>
                        {t.key && <span className="text-muted-foreground text-xs">{t.key}</span>}
                        {t.id === tenantId && <Check className="size-3.5 shrink-0" />}
                      </CommandItem>
                    ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
