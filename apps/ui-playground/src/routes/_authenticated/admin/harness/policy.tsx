import { createFileRoute } from '@tanstack/react-router';
import HarnessPolicyPage from '@/features/admin/harness/policy';

export const Route = createFileRoute('/_authenticated/admin/harness/policy')({
  component: HarnessPolicyPage,
});
