import { createFileRoute, redirect } from '@tanstack/react-router';

/** `/tenants/$tenantId` → the Overview tab (TASK-379 §5.12). */
export const Route = createFileRoute('/_authenticated/tenants/$tenantId/')({
    beforeLoad: ({ params }) => {
        throw redirect({ to: '/tenants/$tenantId/overview', params: { tenantId: params.tenantId } });
    },
});
