import AdminJobsPage from '@/features/admin/jobs';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/jobs')({
  component: () => (
    <RequireAdmin>
      <AdminJobsPage />
    </RequireAdmin>
  ),
});
