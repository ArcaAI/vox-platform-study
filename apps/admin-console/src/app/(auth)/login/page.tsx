import type { Metadata } from 'next';
import { LoginForm } from '@/features/auth/components/login-form';

export const metadata: Metadata = {
  title: 'Sign in',
};

/** Only same-origin absolute paths may be used as a post-login target. */
function sanitizeRedirect(from: string | undefined): string {
  if (from && from.startsWith('/') && !from.startsWith('//')) {
    return from;
  }
  return '/dashboard';
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ from?: string; error?: string; reason?: string }> }) {
  const { from, error, reason } = await searchParams;
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <LoginForm redirectTo={sanitizeRedirect(from)} initialError={error} sessionExpired={reason === 'expired'} />
    </main>
  );
}
