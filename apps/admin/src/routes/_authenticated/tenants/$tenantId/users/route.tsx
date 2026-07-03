import { createFileRoute, Outlet } from '@tanstack/react-router';

/**
 * Users sub-area layout (TASK-381). Pathless wrapper only — the `Users`
 * breadcrumb is contributed by the *detail* route ($userId), so the Users TAB
 * itself ends the trail at the tenant (the active tab is shown by the in-page
 * tab nav, never appended to the breadcrumb). Mirrors `departments/route.tsx`.
 */
export const Route = createFileRoute('/_authenticated/tenants/$tenantId/users')({
  component: () => <Outlet />,
});
