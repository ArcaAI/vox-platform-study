import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Spinner } from '@arcaai/ui/spinner';
import { useUsers } from '@arcaai/vox';
import { createFileRoute, Link } from '@tanstack/react-router';
import { CircleCheck, Plus, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';

// Exported so the generated route tree can name this search shape (avoids TS4023).
export interface ResetPasswordSearch {
  token?: string;
}

export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>): ResetPasswordSearch => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  component: ResetPasswordPage,
});

/**
 * TASK-400 — client-side mirror of the DEFAULT server complexity policy
 * (`security.password.*` GlobalSettings; 12+ chars, upper+lower+digit+special).
 * Inline UX only — the API remains authoritative and its 400 message is shown
 * verbatim if a (relaxed/strict) server-side policy disagrees.
 */
const PASSWORD_RULES: ReadonlyArray<{ id: string; label: string; test: (pw: string) => boolean }> = [
  { id: 'length', label: 'At least 12 characters', test: (pw) => pw.length >= 12 },
  { id: 'upper', label: 'One uppercase letter (A-Z)', test: (pw) => /[A-Z]/.test(pw) },
  { id: 'lower', label: 'One lowercase letter (a-z)', test: (pw) => /[a-z]/.test(pw) },
  { id: 'digit', label: 'One number (0-9)', test: (pw) => /[0-9]/.test(pw) },
  { id: 'special', label: 'One special character (e.g. !@#$%)', test: (pw) => /[^A-Za-z0-9]/.test(pw) },
];

/**
 * Public **reset-password completion** page (TASK-394 P0-1 · TASK-388 #8 ·
 * TASK-400). Consumes a single-use, DB-backed reset token minted by either the
 * admin "Send reset link" flow or the public forgot-password flow, via
 * `useUsers().completePasswordReset({ token, newPassword })`. No session is
 * required — the token in the URL is the credential. Complexity rules are
 * validated inline (TASK-400).
 */
function ResetPasswordPage() {
  const { token } = Route.useSearch();
  const { completePasswordReset } = useUsers();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const unmetRules = PASSWORD_RULES.filter((rule) => !rule.test(password));
  const policyMet = unmetRules.length === 0;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !!token && password.length > 0 && policyMet && password === confirm && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await completePasswordReset({ token, newPassword: password });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This reset link is invalid or has expired.');
    } finally {
      setBusy(false);
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
          <p className="text-sm text-muted-foreground">Set a new password for your account.</p>
        </div>

        <Card className="w-full">
          <CardHeader>
            <CardTitle>Reset password</CardTitle>
            <CardDescription>Choose a new password to finish resetting your account.</CardDescription>
          </CardHeader>
          <CardContent>
            {done ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <CircleCheck className="size-10 text-success" />
                <p className="text-sm text-muted-foreground">Your password has been reset. You can now sign in with your new password.</p>
                <Button asChild className="mt-1 w-full">
                  <Link to="/login">Go to sign in</Link>
                </Button>
              </div>
            ) : !token ? (
              <div role="alert" className="flex flex-col items-center gap-3 text-center">
                <TriangleAlert className="size-9 text-destructive" />
                <p className="text-sm text-muted-foreground">This reset link is missing its token. Ask an administrator for a new reset link.</p>
                <Button asChild variant="outline" className="mt-1 w-full">
                  <Link to="/login">Back to sign in</Link>
                </Button>
              </div>
            ) : (
              <form onSubmit={submit} className="flex flex-col gap-4">
                {error ? (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                  >
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                ) : null}

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-password">New password</Label>
                  <Input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={password.length > 0 && !policyMet}
                    required
                  />
                  {/* TASK-400 — inline complexity checklist (unmet rules only). */}
                  {password.length > 0 && !policyMet ? (
                    <ul data-testid="password-rules" className="flex flex-col gap-0.5 text-xs text-destructive">
                      {unmetRules.map((rule) => (
                        <li key={rule.id}>{rule.label}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirm-password">Confirm password</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    aria-invalid={mismatch}
                    required
                  />
                  {mismatch ? <span className="text-xs text-destructive">Passwords don’t match.</span> : null}
                </div>

                <Button type="submit" className="mt-1 w-full" disabled={!canSubmit}>
                  {busy ? <Spinner className="size-4" /> : 'Reset password'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
