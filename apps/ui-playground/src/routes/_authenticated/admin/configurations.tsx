import ConfigurationManagementPage from '@/features/admin/configurations';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/configurations')({
  component: () => (
    <RequireAdmin>
      <ConfigurationManagementPage />
    </RequireAdmin>
  ),
});
