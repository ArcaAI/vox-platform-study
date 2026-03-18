import ConfigurationManagementPage from '@/features/admin/configurations';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '@/store/auth-store';

function GuardedConfigurationsPage() {
  const roles = useAuthStore((s) => s.user?.roles ?? []);
  const isAllowed =
    roles.includes('SUPER_ADMIN') ||
    roles.includes('GLOBAL_ADMIN') ||
    roles.includes('TENANT_ADMIN');

  if (!isAllowed) return <Navigate to="/403" />;
  return <ConfigurationManagementPage />;
}

export const Route = createFileRoute('/_authenticated/admin/configurations')({
  component: GuardedConfigurationsPage,
});
