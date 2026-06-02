import TenantManagementPage from '@/features/admin/tenants';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/tenants')({
  component: () => (
    <RequireAdmin>
      <TenantManagementPage />
    </RequireAdmin>
  ),
});
