import type { Metadata } from 'next';
import { RegisterForm } from '@/features/auth/components/register-form';

export const metadata: Metadata = {
  title: 'Create account',
};

export default function RegisterPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <RegisterForm />
    </main>
  );
}
