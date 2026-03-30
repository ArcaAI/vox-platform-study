import PromptManagementPage from '@/features/admin/prompts';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '@/store/auth-store';

function GuardedPromptPage() {
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);
  if (!isSuperAdmin()) {
    return <Navigate to="/403" />;
  }
  return <PromptManagementPage />;
}

export const Route = createFileRoute('/_authenticated/admin/prompts')({
  component: GuardedPromptPage,
});
