import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Spinner } from '@arcaai/ui/spinner';
import { useUsers } from '@arcaai/vox';
import { createFileRoute, Link } from '@tanstack/react-router';
import { MailCheck, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';

export const Route = createFileRoute('/forgot-password')({
  component: ForgotPasswordPage,
});

/**
 * Public **forgot-password request** page (TASK-400). Unauthenticated: the user
 * enters their email and the API always acknowledges with the same generic
 * message (no account enumeration) — the reset link travels only via email.
 */
function ForgotPasswordPage() {
  const { requestPasswordReset } = useUsers();

  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const canSubmit = email.trim().length > 3 && email.includes('@') && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await requestPasswordReset({ email: email.trim() });
    } catch {
      // Anti-enumeration: the success state is shown regardless — the API
      // contract is a generic 202 and we never reveal more than it does.
    } finally {
      setBusy(false);
      setSent(true);
    }
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-linear-to-b from-accent/40 to-background p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Plus className="size-7" aria-hidden />
          </span>
          <h1 className="text-xl font-semibold">HOPE Admin Console</h1>
          <p className="text-sm text-muted-foreground">Request a password reset link.</p>
        </div>

        <Card className="w-full">
          <CardHeader>
            <CardTitle>Forgot password</CardTitle>
            <CardDescription>Enter your account email and we&rsquo;ll send you a reset link.</CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <div role="status" className="flex flex-col items-center gap-3 text-center">
                <MailCheck className="size-10 text-success" />
                <p className="text-sm text-muted-foreground">
                  If an account exists for that email, a password reset link has been sent. Check your inbox — the link expires in 60 minutes.
                </p>
                <Button asChild variant="outline" className="mt-1 w-full">
                  <Link to="/login">Back to sign in</Link>
                </Button>
              </div>
            ) : (
              <form onSubmit={submit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    autoFocus
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>

                <Button type="submit" className="mt-1 w-full" disabled={!canSubmit}>
                  {busy ? <Spinner className="size-4" /> : 'Send reset link'}
                </Button>

                <p className="text-center text-xs text-muted-foreground">
                  <Link to="/login" className="underline-offset-4 hover:underline">
                    Back to sign in
                  </Link>
                </p>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
