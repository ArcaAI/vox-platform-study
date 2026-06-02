import UserManagementPage from '@/features/admin/users';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/users')({
  component: () => (
    <RequireAdmin>
      <UserManagementPage />
    </RequireAdmin>
  ),
});
