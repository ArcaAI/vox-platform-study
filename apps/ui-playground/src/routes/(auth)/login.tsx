import Login from '@/features/auth/login';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

const searchSchema = z.object({
    redirect: z.string().optional(),
});

export const Route = createFileRoute('/(auth)/login')({
    component: Login,
    validateSearch: searchSchema,
    beforeLoad: ({ context }) => {
        if (context.isAuthenticated) {
            throw redirect({ to: '/' });
        }
    },
});
