'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { IconAlertCircle, IconCircleCheck } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';

interface ResetPasswordScreenProps {
    token: string | undefined;
}

export function ResetPasswordScreen({ token }: ResetPasswordScreenProps) {
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [done, setDone] = useState(false);

    if (!token) {
        return (
            <Card className="w-full max-w-sm">
                <CardHeader>
                    <CardTitle>Reset link incomplete</CardTitle>
                </CardHeader>
                <CardContent>
                    <Alert variant="destructive">
                        <IconAlertCircle />
                        <AlertTitle>Missing reset token</AlertTitle>
                        <AlertDescription>Please use the link from your password reset email.</AlertDescription>
                    </Alert>
                </CardContent>
            </Card>
        );
    }

    if (done) {
        return (
            <Card className="w-full max-w-sm">
                <CardHeader>
                    <CardTitle>Password updated</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    <Alert>
                        <IconCircleCheck />
                        <AlertTitle>Your password has been reset</AlertTitle>
                    </Alert>
                    <Button asChild>
                        <Link href="/login">Sign in</Link>
                    </Button>
                </CardContent>
            </Card>
        );
    }

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(null);
        if (newPassword !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }
        setSubmitting(true);
        try {
            const response = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ token, newPassword }),
            });
            const data = (await response.json().catch(() => ({}))) as { message?: string };
            if (!response.ok) {
                setError(data.message ?? 'Password reset failed');
                return;
            }
            setDone(true);
        } catch {
            setError('Could not reach the server. Please try again.');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Card className="w-full max-w-sm">
            <CardHeader>
                <CardTitle>Reset your password</CardTitle>
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
                        <Label htmlFor="reset-new-password">New password</Label>
                        <Input
                            id="reset-new-password"
                            type="password"
                            autoComplete="new-password"
                            value={newPassword}
                            onChange={(event) => setNewPassword(event.target.value)}
                            required
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="reset-confirm-password">Confirm new password</Label>
                        <Input
                            id="reset-confirm-password"
                            type="password"
                            autoComplete="new-password"
                            value={confirmPassword}
                            onChange={(event) => setConfirmPassword(event.target.value)}
                            required
                        />
                    </div>
                    <Button type="submit" disabled={submitting}>
                        {submitting ? 'Resetting…' : 'Reset password'}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}
