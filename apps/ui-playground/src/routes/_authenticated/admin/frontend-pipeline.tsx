import FrontendPipelinePage from '@/features/admin/frontend-pipeline';
import { useAuthStore } from '@/store/auth-store';
import { createFileRoute, Navigate } from '@tanstack/react-router';

function GuardedFrontendPipelinePage() {
  const roles = useAuthStore((s) => s.user?.roles ?? []);
  const isAllowed = roles.includes('SUPER_ADMIN') || roles.includes('GLOBAL_ADMIN') || roles.includes('TENANT_ADMIN');

  if (!isAllowed) {
    return <Navigate to="/403" />;
  }

  return <FrontendPipelinePage />;
}

export const Route = createFileRoute('/_authenticated/admin/frontend-pipeline')({
  component: GuardedFrontendPipelinePage,
});
