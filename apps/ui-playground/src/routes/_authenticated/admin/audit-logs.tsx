import AuditLogManagementPage from '@/features/admin/audit-logs';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '@/store/auth-store';

function GuardedAuditLogsPage() {
  const roles = useAuthStore((s) => s.user?.roles ?? []);
  const isAllowed = roles.includes('SUPER_ADMIN') || roles.includes('GLOBAL_ADMIN') || roles.includes('TENANT_ADMIN');

  if (!isAllowed) return <Navigate to="/403" />;
  return <AuditLogManagementPage />;
}

export const Route = createFileRoute('/_authenticated/admin/audit-logs')({
  component: GuardedAuditLogsPage,
});
