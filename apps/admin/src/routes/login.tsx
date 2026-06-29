import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Spinner } from '@arcaai/ui/spinner';
import { useAuth } from '@arcaai/vox';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useAuthStore, type AuthUser } from '@/store/auth-store';

// Exported so the inferred route type (surfaced in the generated route tree) can
// name this search shape — otherwise the exported LoginRoute triggers TS4023.
export interface LoginSearch {
    redirect?: string;
}

export const Route = createFileRoute('/login')({
    validateSearch: (search: Record<string, unknown>): LoginSearch => ({
        redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
    }),
    beforeLoad: ({ context }) => {
        if (context.isAuthenticated) throw redirect({ to: '/tenants' });
    },
    component: LoginPage,
});

function LoginPage() {
    const navigate = useNavigate();
    const search = Route.useSearch();
    const { login, isLoading } = useAuth();
    const setCredentialsAuth = useAuthStore((s) => s.setCredentialsAuth);

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [tenantKey, setTenantKey] = useState('');
    const [error, setError] = useState<string | null>(null);

    const onSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError(null);
        try {
            const res = await login(username.trim(), password, tenantKey.trim() || undefined);
            const user: AuthUser = {
                id: res.user.id,
                email: res.user.email,
                username: res.user.username,
                roles: res.user.roles ?? [],
                permissions: res.user.permissions ?? [],
            };
            setCredentialsAuth(res.token, user, res.user.tenantId ?? '', res.user.tenantKey ?? tenantKey.trim(), res.refreshToken);
            toast.success(`Welcome back, ${user.username}`);
            navigate({ to: '/tenants' });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Login failed. Check your credentials and try again.';
            setError(message);
        }
    };

    return (
        <div className="flex min-h-svh items-center justify-center bg-gradient-to-b from-accent/40 to-background p-4">
            <div className="flex w-full max-w-sm flex-col items-center gap-6">
                <div className="flex flex-col items-center gap-2 text-center">
                    <span className="flex size-12 items-center justify-center rounded-xl bg-primary text-2xl font-semibold text-primary-foreground shadow-sm">+</span>
                    <h1 className="text-xl font-semibold">HOPE Admin Console</h1>
                    <p className="text-sm text-muted-foreground">Quiet intelligence that helps clinicians care for people.</p>
                </div>

                <Card className="w-full">
                    <CardHeader>
                        <CardTitle>Sign in</CardTitle>
                        <CardDescription>Use your operator credentials to continue.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={onSubmit} className="flex flex-col gap-4">
                            {error ? (
                                <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                                    <span>{error}</span>
                                </div>
                            ) : null}

                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="username">Username or email</Label>
                                <Input id="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="password">Password</Label>
                                <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="tenantKey">
                                    Workspace key <span className="font-normal text-muted-foreground">(optional)</span>
                                </Label>
                                <Input id="tenantKey" autoComplete="organization" placeholder="e.g. acme-health" value={tenantKey} onChange={(e) => setTenantKey(e.target.value)} />
                            </div>

                            <Button type="submit" className="mt-1 w-full" disabled={isLoading || !username || !password}>
                                {isLoading ? <Spinner className="size-4" /> : 'Sign in'}
                            </Button>
                        </form>
                    </CardContent>
                </Card>

                {search.redirect ? <p className="text-xs text-muted-foreground">You’ll return to your requested page after signing in.</p> : null}
            </div>
        </div>
    );
}
