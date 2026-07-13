'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { IconAlertCircle, IconClockExclamation } from '@tabler/icons-react';
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
}

export function LoginForm({ redirectTo, initialError }: LoginFormProps) {
    const router = useRouter();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [tenantKey, setTenantKey] = useState('');
    const [error, setError] = useState<string | null>(initialError ?? null);
    const [passwordExpired, setPasswordExpired] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [ssoEmail, setSsoEmail] = useState('');
    const [ssoSubmitting, setSsoSubmitting] = useState(false);

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
                            value={username}
                            onChange={(event) => setUsername(event.target.value)}
                            required
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="login-password">Password</Label>
                        <Input
                            id="login-password"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            required
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="login-tenant-key">Tenant key (optional for global admins)</Label>
                        <Input
                            id="login-tenant-key"
                            autoComplete="organization"
                            value={tenantKey}
                            onChange={(event) => setTenantKey(event.target.value)}
                        />
                    </div>
                    <Button type="submit" disabled={submitting}>
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
