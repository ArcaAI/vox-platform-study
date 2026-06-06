import RateLimitsPage from '@/features/admin/rate-limit';
import { RequireGlobalScope } from '@/components/admin-route-guard';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/admin/rate-limits')({
  component: () => (
    <RequireGlobalScope>
      <RateLimitsPage />
    </RequireGlobalScope>
  ),
});
