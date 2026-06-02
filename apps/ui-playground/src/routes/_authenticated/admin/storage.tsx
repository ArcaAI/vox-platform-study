import StorageManagementPage from '@/features/admin/storage';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/storage')({
  component: () => (
    <RequireAdmin>
      <StorageManagementPage />
    </RequireAdmin>
  ),
});
