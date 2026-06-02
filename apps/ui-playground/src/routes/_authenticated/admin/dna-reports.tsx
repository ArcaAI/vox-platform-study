import DnaReportsAdminPage from '@/features/admin/dna-reports';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/dna-reports')({
  component: () => (
    <RequireAdmin>
      <DnaReportsAdminPage />
    </RequireAdmin>
  ),
});
