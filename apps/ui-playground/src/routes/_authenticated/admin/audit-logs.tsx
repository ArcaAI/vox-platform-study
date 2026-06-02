import AuditLogManagementPage from '@/features/admin/audit-logs';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/audit-logs')({
  component: () => (
    <RequireAdmin>
      <AuditLogManagementPage />
    </RequireAdmin>
  ),
});
