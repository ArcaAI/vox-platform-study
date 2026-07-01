import { createFileRoute, Outlet } from '@tanstack/react-router';

/**
 * Departments sub-area layout (TASK-379 §5.12). Pathless wrapper only — the
 * `Departments` breadcrumb is contributed by the *detail* route ($departmentId),
 * so the Departments TAB itself ends the trail at the tenant (the active tab is
 * shown by the in-page tab nav, never appended to the breadcrumb).
 */
export const Route = createFileRoute('/_authenticated/tenants/$tenantId/departments')({
    component: () => <Outlet />,
});
