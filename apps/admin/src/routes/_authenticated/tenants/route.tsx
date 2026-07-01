import { createFileRoute, Outlet } from '@tanstack/react-router';

/**
 * Tenants area layout (TASK-379 §5.12). A pathless wrapper so both the list
 * (`index.tsx`) and the nested detail (`$tenantId/*`) share the `Platform /
 * Tenants` breadcrumb prefix. Renders only the outlet — no extra chrome.
 */
export const Route = createFileRoute('/_authenticated/tenants')({
    staticData: { crumb: [{ label: 'Platform', to: null }, { label: 'Tenants' }] },
    component: () => <Outlet />,
});
