import type { Metadata } from 'next';
import { VerifyEmailScreen } from '@/features/auth/components/verify-email-screen';

export const metadata: Metadata = {
    title: 'Verify email',
};

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
    const { token } = await searchParams;
    return (
        <main className="flex min-h-svh items-center justify-center p-6">
            <VerifyEmailScreen token={token} />
        </main>
    );
}
