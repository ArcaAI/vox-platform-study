import { createFileRoute, Outlet } from '@tanstack/react-router';

/**
 * Agent-management sub-area layout (TASK-382 §2.1). Pathless wrapper only — the
 * department-detail crumb (`… / Departments / «dept»`) is contributed by the
 * `$departmentId` layout; the Agent-instructions sub-tab is shown by the in-page
 * nav and never appended to the breadcrumb.
 */
export const Route = createFileRoute('/_authenticated/tenants/$tenantId/departments/$departmentId/agents')({
    component: () => <Outlet />,
});
