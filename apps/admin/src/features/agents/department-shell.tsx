import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { Tenant } from '@arcaai/vox';
import type { Department } from '@/features/tenants/sdk-types';
import { resourceStatusLabel, resourceStatusRole } from '@/features/data-grid/status';
import { initialsOf, cn } from '@/lib/utils';

const TAB_CLASS = cn(
    '-mb-px border-b-2 border-transparent px-3 py-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors',
    'hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'data-[status=active]:border-primary data-[status=active]:text-foreground',
);

/**
 * Department-detail chrome (frame 36p) shared by the Members and Agent-instructions
 * sub-tabs: identity header + an actions slot + the routed sub-tab nav. The active
 * sub-tab is shown here (it is intentionally NOT appended to the breadcrumb).
 */
export function DepartmentDetailShell({
    department,
    tenant,
    tenantId,
    departmentId,
    active,
    actions,
    children,
}: {
    department: Department;
    tenant: Tenant | null;
    tenantId: string;
    departmentId: string;
    active: 'members' | 'agents';
    actions?: ReactNode;
    children: ReactNode;
}) {
    const status = department.resourceStatus as string | undefined;
    const code = department.code ? String(department.code) : undefined;

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                    <Avatar className="size-12">
                        <AvatarFallback className="rounded-lg bg-primary/10 text-base font-semibold text-primary">
                            {initialsOf(department.name)}
                        </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <h1 className="truncate text-xl font-semibold">{department.name}</h1>
                            {status ? <StatusBadge label={resourceStatusLabel(status)} colorRole={resourceStatusRole(status)} /> : null}
                        </div>
                        <p className="truncate text-sm text-muted-foreground">
                            {tenant?.name ? `${tenant.name} · ` : ''}Department
                            {code ? <span className="font-mono"> · {code}</span> : null}
                        </p>
                    </div>
                </div>
                {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
            </div>

            <nav aria-label="Department sections" className="flex gap-1 overflow-x-auto border-b border-border">
                <Link
                    to="/tenants/$tenantId/departments/$departmentId"
                    params={{ tenantId, departmentId }}
                    data-status={active === 'members' ? 'active' : undefined}
                    className={TAB_CLASS}
                >
                    Members
                </Link>
                <Link
                    to="/tenants/$tenantId/departments/$departmentId/agents"
                    params={{ tenantId, departmentId }}
                    data-status={active === 'agents' ? 'active' : undefined}
                    className={TAB_CLASS}
                >
                    Agent instructions
                </Link>
            </nav>

            {children}
        </div>
    );
}
