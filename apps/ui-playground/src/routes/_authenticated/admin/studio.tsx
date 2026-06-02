import StudioPage from '@/features/admin/components/studio-page';
import { RequireGlobalScope } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/studio')({
  component: () => (
    <RequireGlobalScope>
      <StudioPage />
    </RequireGlobalScope>
  ),
});
