import { Button } from '@arcaai/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Skeleton } from '@arcaai/ui/skeleton';
import { useDepartments } from '@arcaai/vox';
import type { Department } from '@/features/tenants/sdk-types';
import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { FolderTree } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

/**
 * Department-detail layout (TASK-382 §2.1). Fetches the department once, publishes
 * it (with the tenant) to the tenant-detail store for the breadcrumb + the child
 * pages (`useDepartmentScope`), and gates on load so Members / Agents / the
 * instruction workspace always read a non-null department. The active sub-tab is
 * shown by the in-page nav, so only `Departments / «dept»` is appended here.
 */
export const Route = createFileRoute('/_authenticated/tenants/$tenantId/departments/$departmentId')({
  staticData: { crumb: [{ label: 'Departments', to: '/tenants/$tenantId/departments' }, { label: { from: 'department' } }] },
  component: DepartmentDetailLayout,
});

function DepartmentDetailLayout() {
  const { tenantId, departmentId } = Route.useParams();
  const { get } = useDepartments();
  const setDepartment = useTenantDetailStore((s) => s.setDepartment);

  const [dept, setDept] = useState<Department | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    get(departmentId)
      .then((d) => {
        setDept(d);
        setDepartment(d);
      })
      .catch((e) => setError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => setLoading(false));
    return () => setDepartment(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentId]);

  if (loading && !dept) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="size-12 rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !dept) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderTree />
          </EmptyMedia>
          <EmptyTitle>Department not found</EmptyTitle>
          <EmptyDescription>This department doesn’t exist or you don’t have access to it.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline">
            <Link to="/tenants/$tenantId/departments" params={{ tenantId }}>
              Back to departments
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return <Outlet />;
}
