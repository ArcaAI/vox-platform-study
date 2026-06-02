import BackendPipelinePage from '@/features/admin/backend-pipeline';
import { useAuthStore } from '@/store/auth-store';
import { createFileRoute, Navigate } from '@tanstack/react-router';

function GuardedBackendPipelinePage() {
  const roles = useAuthStore((s) => s.user?.roles ?? []);
  const isAllowed = roles.includes('SUPER_ADMIN') || roles.includes('GLOBAL_ADMIN') || roles.includes('TENANT_ADMIN');

  if (!isAllowed) {
    return <Navigate to="/403" />;
  }

  return <BackendPipelinePage />;
}

export const Route = createFileRoute('/_authenticated/admin/backend-pipeline')({
  component: GuardedBackendPipelinePage,
});
