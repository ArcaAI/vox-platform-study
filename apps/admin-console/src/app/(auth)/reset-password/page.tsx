import type { Metadata } from 'next';
import { ResetPasswordScreen } from '@/features/auth/components/reset-password-screen';

export const metadata: Metadata = {
  title: 'Reset password',
};

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <ResetPasswordScreen token={token} />
    </main>
  );
}
