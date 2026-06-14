import AiModelsPage from '@/features/admin/ai-models';
import { RequireAdmin } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/ai-models')({
  component: () => (
    <RequireAdmin>
      <AiModelsPage />
    </RequireAdmin>
  ),
});
