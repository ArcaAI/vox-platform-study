import DepartmentManagementPage from '@/features/admin/departments';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/departments')({
  component: () => (
    <RequireAdmin>
      <DepartmentManagementPage />
    </RequireAdmin>
  ),
});
