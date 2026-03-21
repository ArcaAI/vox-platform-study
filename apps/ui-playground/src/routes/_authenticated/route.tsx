import { AuthLayout } from '@/components/layout/auth-layout';
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated')({
    beforeLoad: ({ context, location }) => {
        if (!context.isAuthenticated) {
            throw redirect({
                to: '/login',
                search: { redirect: location.href },
            });
        }
    },
    component: AuthLayout,
});
