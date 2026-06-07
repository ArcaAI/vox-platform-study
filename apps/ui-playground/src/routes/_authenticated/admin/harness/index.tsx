import { createFileRoute, redirect } from '@tanstack/react-router';

/** `/admin/harness` redirects to the Overview tab. */
export const Route = createFileRoute('/_authenticated/admin/harness/')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/harness/overview' });
  },
});
