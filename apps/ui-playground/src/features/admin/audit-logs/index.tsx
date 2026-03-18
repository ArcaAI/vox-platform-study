import { useMemo, useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Badge } from '@arcaai/ui/badge';
import { Input } from '@arcaai/ui/input';
import { Main } from '@/components/layout/main';
import { useAuthStore } from '@/store/auth-store';
import { AdminDataTable } from '../components';
import { type Tenant, useTenantsInfinite } from '../api/tenants';
import { type AuditLog, useTenantAuditLogs } from '../api/audit-logs';

function formatDate(date?: string) {
  if (!date) return '—';
  return new Date(date).toLocaleString();
}

const ACTION_COLOR: Record<string, string> = {
  CREATE: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  UPDATE: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  DELETE: 'bg-red-500/15 text-red-700 dark:text-red-400',
};

export default function AuditLogManagementPage() {
  const roles = useAuthStore((s: { user?: { roles?: string[] } | null }) => s.user?.roles ?? []);
  const tenantId = useAuthStore((s: { tenantId: string }) => s.tenantId);
  const tenantName = useAuthStore((s: { tenantName: string }) => s.tenantName);
  const isSuperOrGlobalAdmin = roles.includes('SUPER_ADMIN') || roles.includes('GLOBAL_ADMIN');

  const [searchTenant, setSearchTenant] = useState('');
  const [searchAudit, setSearchAudit] = useState('');
  const [selectedTenantId, setSelectedTenantId] = useState(tenantId || '');
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 25,
  });

  const {
    data: tenantsPages,
    isLoading: tenantsLoading,
  } = useTenantsInfinite(25, { enabled: isSuperOrGlobalAdmin });

  const tenantRows = useMemo<Tenant[]>(() => {
    if (!isSuperOrGlobalAdmin) {
      if (!tenantId) return [];
      return [{
        id: tenantId,
        name: tenantName || tenantId,
        key: tenantId,
        resourceStatus: 'ENABLED',
        createdAt: '',
        updatedAt: '',
      } as Tenant];
    }
    return tenantsPages?.pages.flatMap((page) => page.data) ?? [];
  }, [isSuperOrGlobalAdmin, tenantId, tenantName, tenantsPages]);

  const filteredTenants = useMemo(
    () =>
      tenantRows.filter((tenant) =>
        `${tenant.name} ${tenant.key}`.toLowerCase().includes(searchTenant.toLowerCase()),
      ),
    [tenantRows, searchTenant],
  );

  const effectiveTenant = isSuperOrGlobalAdmin ? selectedTenantId : tenantId;
  const { data: auditResponse, isLoading: auditLoading } = useTenantAuditLogs(
    effectiveTenant || '',
    {
      page: pagination.pageIndex + 1,
      limit: pagination.pageSize,
      search: searchAudit || undefined,
    },
    { enabled: !!effectiveTenant },
  );

  const columns = useMemo<ColumnDef<AuditLog, unknown>[]>(
    () => [
      {
        accessorKey: 'createdAt',
        header: 'Timestamp',
        cell: ({ row }) => formatDate(row.original.createdAt),
      },
      {
        accessorKey: 'action',
        header: 'Action',
        cell: ({ row }) => (
          <Badge
            variant="outline"
            className={ACTION_COLOR[row.original.action] ?? 'bg-muted'}
          >
            {row.original.action}
          </Badge>
        ),
      },
      {
        accessorKey: 'resourceType',
        header: 'Resource',
      },
      {
        accessorKey: 'resourceId',
        header: 'Resource ID',
        cell: ({ row }) => (
          <span className="block max-w-64 truncate font-mono text-xs">
            {String(row.original.resourceId ?? '—')}
          </span>
        ),
      },
      {
        accessorKey: 'responsibleIp',
        header: 'IP',
        cell: ({ row }) => String(row.original.responsibleIp ?? '—'),
      },
    ],
    [],
  );

  return (
    <Main>
      <div className="mb-4">
        <h2 className="text-2xl font-bold tracking-tight">Audit Log</h2>
        <p className="text-muted-foreground mt-1">
          Tenant activities with TanStack-powered table, search, and pagination.
        </p>
      </div>

      <div className="mb-4 grid gap-3 md:grid-cols-[320px_1fr]">
        <div className="rounded-md border p-3">
          <Input
            value={searchTenant}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setSearchTenant(event.target.value)
            }
            placeholder="Search tenant..."
            className="mb-3"
          />
          <div className="max-h-60 overflow-auto">
            {tenantsLoading ? (
              <p className="text-muted-foreground text-sm">Loading tenants...</p>
            ) : (
              filteredTenants.map((tenant) => (
                <button
                  key={tenant.id}
                  type="button"
                  className="hover:bg-muted flex w-full items-center justify-between rounded-md px-2 py-2 text-left"
                  onClick={() => {
                    if (isSuperOrGlobalAdmin) {
                      setSelectedTenantId(tenant.id);
                      setPagination((prev) => ({ ...prev, pageIndex: 0 }));
                    }
                  }}
                >
                  <span className="truncate text-sm">{tenant.name}</span>
                  <span className="text-muted-foreground truncate text-xs">{tenant.key}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="rounded-md border p-3">
          <Input
            value={searchAudit}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              setSearchAudit(event.target.value);
              setPagination((prev) => ({ ...prev, pageIndex: 0 }));
            }}
            placeholder="Search action/resource..."
            className="mb-3"
          />
          <AdminDataTable
            data={auditResponse?.data ?? []}
            columns={columns}
            pagination={pagination}
            onPaginationChange={setPagination}
            rowCount={auditResponse?.count ?? 0}
            isLoading={auditLoading}
            emptyMessage="No audit logs found."
          />
        </div>
      </div>
    </Main>
  );
}
