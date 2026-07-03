import { createFileRoute, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/app-shell';

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ context, location }) => {
    if (!context.isAuthenticated) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: AppShell,
});
