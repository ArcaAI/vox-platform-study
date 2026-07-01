import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@arcaai/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@arcaai/ui/popover';
import { useTenants } from '@arcaai/vox';
import { Link } from '@tanstack/react-router';
import { Building2, Check, ChevronsUpDown, Globe } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isSuperAdmin } from '@/features/tenants/permissions';
import { initialsOf } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';

/**
 * Working-tenant switcher (TASK-371 §5.12, foundation-15). Super-admins pick the
 * tenant they're "acting on" — selection writes `auth-store.setTenant()`, which
 * the SDK provider folds into the `X-Tenant-Id` header so tenant-scoped reads/
 * writes target it. "All tenants" clears the context (cross-tenant view). A
 * tenant-admin is locked to their own workspace, so they see a static chip.
 */
/** `collapsed`: avatar-only pill for the tablet icon-rail (TASK-384). */
export function WorkingTenantSwitcher({ collapsed }: { collapsed?: boolean } = {}) {
    const roles = useAuthStore((s) => s.user?.roles);
    const tenantId = useAuthStore((s) => s.tenantId);
    const tenantKey = useAuthStore((s) => s.tenantKey);
    const setTenant = useAuthStore((s) => s.setTenant);
    const superAdmin = isSuperAdmin(roles);

    const { tenants, list } = useTenants();
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (open && superAdmin && tenants.length === 0) void list().catch(() => undefined);
    }, [open, superAdmin, tenants.length, list]);

    if (!superAdmin) {
        if (!tenantKey) return null;
        return (
            <div
                className={cn('flex items-center gap-2.5 rounded-md px-2 py-1.5', collapsed && 'justify-center')}
                title={collapsed ? `${tenantKey} · workspace` : 'Your workspace'}
            >
                <Avatar className="size-8">
                    <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">{initialsOf(tenantKey)}</AvatarFallback>
                </Avatar>
                {!collapsed ? (
                    <span className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate text-sm font-medium text-sidebar-foreground">{tenantKey}</span>
                        <span className="text-xs text-muted-foreground">Workspace</span>
                    </span>
                ) : null}
            </div>
        );
    }

    const current = tenants.find((t) => t.id === tenantId) ?? null;

    const select = (id: string, key: string) => {
        setTenant(id, key);
        setOpen(false);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label={current ? `Working tenant: ${current.name}. Switch working tenant.` : 'Switch working tenant'}
                    title={collapsed ? (current ? current.name : 'All tenants · cross-tenant') : undefined}
                    className={cn(
                        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                        collapsed && 'justify-center',
                    )}
                >
                    <Avatar className="size-8">
                        <AvatarFallback
                            className={cn('text-xs font-medium', current ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}
                        >
                            {current ? initialsOf(current.name) : <Globe className="size-4" />}
                        </AvatarFallback>
                    </Avatar>
                    {!collapsed ? (
                        <>
                            <span className="flex min-w-0 flex-1 flex-col leading-tight">
                                <span className="truncate text-sm font-medium text-sidebar-foreground">{current ? current.name : 'All tenants'}</span>
                                <span className="truncate text-xs text-muted-foreground">{current ? 'Working tenant' : 'Cross-tenant view'}</span>
                            </span>
                            <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                        </>
                    ) : null}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="w-72 p-0">
                <Command>
                    <CommandInput placeholder="Search tenants…" />
                    <CommandList>
                        <CommandEmpty>No tenants found.</CommandEmpty>
                        <CommandGroup>
                            <CommandItem value="__all__" onSelect={() => select('', '')}>
                                <Globe className="size-4 text-muted-foreground" />
                                <span className="flex flex-1 flex-col">
                                    <span>All tenants</span>
                                    <span className="text-xs text-muted-foreground">Cross-tenant view</span>
                                </span>
                                {!current ? <Check className="size-4" /> : null}
                            </CommandItem>
                        </CommandGroup>
                        <CommandSeparator />
                        <CommandGroup heading="Tenants">
                            {tenants.map((t) => (
                                <CommandItem key={t.id} value={`${t.name} ${String(t.key ?? '')}`} onSelect={() => select(t.id, String(t.key ?? ''))}>
                                    <Avatar className="size-5">
                                        <AvatarFallback className="bg-primary/10 text-[10px] font-medium text-primary">{initialsOf(t.name)}</AvatarFallback>
                                    </Avatar>
                                    <span className="flex min-w-0 flex-1 flex-col">
                                        <span className="truncate">{t.name}</span>
                                        {t.key ? <span className="truncate font-mono text-xs text-muted-foreground">{String(t.key)}</span> : null}
                                    </span>
                                    {t.id === tenantId ? <Check className="size-4" /> : null}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                        <CommandSeparator />
                        <CommandGroup>
                            <CommandItem value="__manage__" asChild>
                                <Link to="/tenants" onClick={() => setOpen(false)}>
                                    <Building2 className="size-4 text-muted-foreground" />
                                    Manage tenants
                                </Link>
                            </CommandItem>
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
