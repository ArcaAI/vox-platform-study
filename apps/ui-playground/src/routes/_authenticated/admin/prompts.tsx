import PromptManagementPage from '@/features/admin/prompts';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/prompts')({
  component: () => (
    <RequireAdmin>
      <PromptManagementPage />
    </RequireAdmin>
  ),
});
