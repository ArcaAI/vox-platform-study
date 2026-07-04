'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { IconAlertCircle, IconClockExclamation } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';

interface LoginFormProps {
    /** Internal path to land on after a successful sign-in (?from=...). */
    redirectTo: string;
}

export function LoginForm({ redirectTo }: LoginFormProps) {
    const router = useRouter();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [tenantKey, setTenantKey] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [passwordExpired, setPasswordExpired] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    function finishLogin() {
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
                        <Label htmlFor="login-tenant-key">Tenant key (optional for super admins)</Label>
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
            </CardContent>
        </Card>
    );
}
