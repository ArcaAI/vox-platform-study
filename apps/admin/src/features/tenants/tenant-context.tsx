import { Button } from '@arcaai/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Link } from '@tanstack/react-router';
import { Building2, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * "Acting on: «Tenant»" banner (TASK-371 §5.12, foundation-15). Shown on
 * tenant-scoped mutation surfaces when a super-admin is operating inside a
 * specific tenant, so the cross-tenant blast radius is always explicit.
 */
export function ActingOnBanner({ tenantName, description, className }: { tenantName: string; description?: ReactNode; className?: string }) {
    return (
        <div
            role="status"
            className={cn('flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-2.5 text-sm', className)}
        >
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
                <p className="font-medium text-foreground">
                    Acting on: <span className="text-primary">{tenantName}</span>
                </p>
                {description ? <p className="text-muted-foreground">{description}</p> : null}
            </div>
        </div>
    );
}

/**
 * NoTenant empty state (GAP-ADM-001). Tenant-scoped pages render this when a
 * super-admin has no working tenant selected, instead of silently showing
 * cross-tenant data. Directs the user to the sidebar switcher; a read-only
 * "View all tenants" escape hatch is offered.
 */
export function NoTenantState({ resource = 'data' }: { resource?: string }) {
    return (
        <Empty>
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <Building2 />
                </EmptyMedia>
                <EmptyTitle>Select a tenant to continue</EmptyTitle>
                <EmptyDescription>
                    Choose a working tenant from the switcher in the sidebar to view and manage its {resource}.
                </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
                <Button asChild variant="outline">
                    <Link to="/tenants">View all tenants</Link>
                </Button>
            </EmptyContent>
        </Empty>
    );
}
