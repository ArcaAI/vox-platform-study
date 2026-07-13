'use client';

import { useState, type FormEvent } from 'react';
import { IconAlertCircle, IconMailCheck } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';

type Status = 'idle' | 'submitting' | 'sent' | 'disabled';

/**
 * TASK-497 D1 — self-service registration. Anti-enumeration at the UI layer
 * too: any non-404 outcome (success, unknown email collision, transient
 * error) renders the SAME "check your email" confirmation — mirrors
 * `RegistrationService.register`'s server-side contract. A 404 (feature flag
 * off) is the one distinct case worth surfacing, since it is an operational
 * state, not information about any particular account.
 */
export function RegisterForm() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [tenantName, setTenantName] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [status, setStatus] = useState<Status>('idle');

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setStatus('submitting');
        try {
            const response = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    email,
                    password,
                    tenantName,
                    ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
                }),
            });
            setStatus(response.status === 404 ? 'disabled' : 'sent');
        } catch {
            // Network failure — still the generic confirmation (anti-enumeration).
            setStatus('sent');
        }
    }

    if (status === 'sent') {
        return (
            <Card className="w-full max-w-sm">
                <CardHeader>
                    <CardTitle>Check your email</CardTitle>
                </CardHeader>
                <CardContent>
                    <Alert>
                        <IconMailCheck />
                        <AlertTitle>Verification link sent</AlertTitle>
                        <AlertDescription>If that email can be registered, we&apos;ve sent a link to verify it and finish setting up your account.</AlertDescription>
                    </Alert>
                </CardContent>
            </Card>
        );
    }

    if (status === 'disabled') {
        return (
            <Card className="w-full max-w-sm">
                <CardHeader>
                    <CardTitle>Registration is not currently available</CardTitle>
                </CardHeader>
                <CardContent>
                    <Alert variant="destructive">
                        <IconAlertCircle />
                        <AlertTitle>Self-service registration is disabled</AlertTitle>
                        <AlertDescription>Please contact your administrator for access.</AlertDescription>
                    </Alert>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="w-full max-w-sm">
            <CardHeader>
                <CardTitle>Create your HOPE account</CardTitle>
                <CardDescription>Sets up a new organization with you as its admin</CardDescription>
            </CardHeader>
            <CardContent>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="register-email">Email</Label>
                        <Input
                            id="register-email"
                            type="email"
                            autoComplete="email"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            required
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="register-password">Password</Label>
                        <Input
                            id="register-password"
                            type="password"
                            autoComplete="new-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            required
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="register-tenant-name">Tenant name</Label>
                        <Input
                            id="register-tenant-name"
                            autoComplete="organization"
                            value={tenantName}
                            onChange={(event) => setTenantName(event.target.value)}
                            placeholder="Sunrise Medical Group"
                            required
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="register-display-name">Display name (optional)</Label>
                        <Input
                            id="register-display-name"
                            autoComplete="name"
                            value={displayName}
                            onChange={(event) => setDisplayName(event.target.value)}
                        />
                    </div>
                    <Button type="submit" disabled={status === 'submitting'}>
                        {status === 'submitting' ? 'Creating account…' : 'Create account'}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}
