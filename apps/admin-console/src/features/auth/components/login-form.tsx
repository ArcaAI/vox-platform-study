'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { IconAlertCircle, IconCircleCheck, IconClockExclamation, IconEye, IconEyeOff } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { invalidateGridLayoutCache } from '@/shared/data/grid-persistence';

interface LoginFormProps {
  /** Internal path to land on after a successful sign-in (?from=...). */
  redirectTo: string;
  /** Surfaced from a failed /api/auth/sso/callback redirect (?error=...). */
  initialError?: string;
  /** ?reason=expired — the console sent the operator here, they did not fail to sign in. */
  sessionExpired?: boolean;
}

export function LoginForm({ redirectTo, initialError, sessionExpired = false }: LoginFormProps) {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [tenantKey, setTenantKey] = useState('');
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [passwordExpired, setPasswordExpired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ssoEmail, setSsoEmail] = useState('');
  const [ssoSubmitting, setSsoSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);
  const [forgotPasswordEmail, setForgotPasswordEmail] = useState('');
  const [forgotPasswordSubmitting, setForgotPasswordSubmitting] = useState(false);
  const [forgotPasswordSent, setForgotPasswordSent] = useState(false);
  const [forgotPasswordError, setForgotPasswordError] = useState<string | null>(null);

  function finishLogin() {
    // Soft navigation keeps module state alive — a previous session's
    // grid-layout cache must not leak into the new identity.
    invalidateGridLayoutCache();
    router.replace(redirectTo);
    router.refresh();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          ...(tenantKey.trim() ? { tenantKey: tenantKey.trim() } : {}),
        }),
      });
      const data = (await response.json()) as { message?: string; passwordExpired?: boolean };
      if (!response.ok) {
        setError(data.message ?? 'Login failed');
        return;
      }
      if (data.passwordExpired) {
        setPasswordExpired(true);
        return;
      }
      finishLogin();
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSsoSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSsoSubmitting(true);
    try {
      const response = await fetch('/api/auth/sso/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ssoEmail.trim() }),
      });
      const data = (await response.json()) as { message?: string; authorizeUrl?: string };
      if (!response.ok || !data.authorizeUrl) {
        setError(data.message ?? 'Could not start single sign-on');
        return;
      }
      // A real cross-origin redirect to the tenant's IdP — not client-side routing.
      window.location.href = data.authorizeUrl;
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSsoSubmitting(false);
    }
  }

  async function handleForgotPasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setForgotPasswordError(null);
    setForgotPasswordSubmitting(true);
    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: forgotPasswordEmail.trim() }),
      });
      const data = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        setForgotPasswordError(data.message ?? 'Could not send reset link');
        return;
      }
      setForgotPasswordSent(true);
    } catch {
      setForgotPasswordError('Could not reach the server. Please try again.');
    } finally {
      setForgotPasswordSubmitting(false);
    }
  }

  function closeForgotPassword() {
    setForgotPasswordOpen(false);
    setForgotPasswordSent(false);
    setForgotPasswordError(null);
    setForgotPasswordEmail('');
  }

  if (forgotPasswordOpen) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Reset your password</CardTitle>
          <CardDescription>Enter your account email and we&apos;ll send you a reset link.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {forgotPasswordSent ? (
            <Alert>
              <IconCircleCheck />
              <AlertTitle>Check your email</AlertTitle>
              <AlertDescription>If an account exists for that email, a password reset link has been sent.</AlertDescription>
            </Alert>
          ) : (
            <form onSubmit={handleForgotPasswordSubmit} className="flex flex-col gap-4">
              {forgotPasswordError ? (
                <Alert variant="destructive">
                  <IconAlertCircle />
                  <AlertTitle>{forgotPasswordError}</AlertTitle>
                </Alert>
              ) : null}
              <div className="flex flex-col gap-2">
                <Label htmlFor="forgot-password-email">Email</Label>
                <Input
                  id="forgot-password-email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={forgotPasswordEmail}
                  onChange={(event) => setForgotPasswordEmail(event.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={forgotPasswordSubmitting}>
                {forgotPasswordSubmitting ? <Spinner /> : null}
                {forgotPasswordSubmitting ? 'Sending…' : 'Send reset link'}
              </Button>
            </form>
          )}
          <Button type="button" variant="ghost" onClick={closeForgotPassword}>
            Back to sign in
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (passwordExpired) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Password expired</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert>
            <IconClockExclamation />
            <AlertTitle>Your password has expired</AlertTitle>
            <AlertDescription>Please change it from your account settings after signing in.</AlertDescription>
          </Alert>
          <Button onClick={finishLogin}>Continue</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>HOPE Admin Console</CardTitle>
        <CardDescription>Sign in with your administrator account</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {sessionExpired && !error ? (
            <Alert>
              <IconClockExclamation />
              <AlertTitle>Your session expired</AlertTitle>
              <AlertDescription>Sign in to continue where you left off.</AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <IconAlertCircle />
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-username">Username</Label>
            <Input
              id="login-username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="login-password">Password</Label>
              <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setForgotPasswordOpen(true)}>
                Forgot password?
              </Button>
            </div>
            <div className="relative">
              <Input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                className="pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1 -translate-y-1/2"
                onClick={() => setShowPassword((previous) => !previous)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <IconEyeOff aria-hidden /> : <IconEye aria-hidden />}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-tenant-key">Tenant key (optional for super admins)</Label>
            <Input id="login-tenant-key" autoComplete="organization" value={tenantKey} onChange={(event) => setTenantKey(event.target.value)} />
          </div>
          <Button type="submit" disabled={submitting}>
            {submitting ? <Spinner /> : null}
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <div className="my-4 flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-xs">or</span>
          <Separator className="flex-1" />
        </div>

        <form onSubmit={handleSsoSubmit} className="flex flex-col gap-2">
          <Label htmlFor="login-sso-email">Sign in with your organization</Label>
          <div className="flex gap-2">
            <Input
              id="login-sso-email"
              type="email"
              autoComplete="email"
              placeholder="you@your-org.com"
              value={ssoEmail}
              onChange={(event) => setSsoEmail(event.target.value)}
              required
            />
            <Button type="submit" variant="outline" disabled={ssoSubmitting || !ssoEmail.trim()}>
              {ssoSubmitting ? <Spinner /> : null}
              Continue
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
