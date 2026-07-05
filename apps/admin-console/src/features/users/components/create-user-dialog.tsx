'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { GatewayError } from '@/shared/api';
import { useCreateUser } from '../api/hooks';
import type { CreateUserRequest } from '../api/types';

/**
 * Create-user dialog (frame 20 primary action). Identity fields only —
 * role/department assignment lives on the detail tabs where the frame puts
 * it. Navigates to the new user on success.
 */
export function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const router = useRouter();
    const createUser = useCreateUser();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [email, setEmail] = useState('');
    const [externalId, setExternalId] = useState('');
    const [serviceAccount, setServiceAccount] = useState(false);

    const valid = username.trim().length > 0 && password.length > 0;

    function handleOpenChange(next: boolean) {
        if (!next) {
            setUsername('');
            setPassword('');
            setEmail('');
            setExternalId('');
            setServiceAccount(false);
            createUser.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!valid) return;
        const body: CreateUserRequest = {
            username: username.trim(),
            password,
            ...(email.trim() ? { email: email.trim() } : {}),
            ...(externalId.trim() ? { externalId: externalId.trim() } : {}),
            ...(serviceAccount ? { isServiceAccount: true } : {}),
        };
        createUser.mutate(body, {
            onSuccess: (created) => {
                toast.success('User created');
                handleOpenChange(false);
                if (created?.id) router.push(`/users/${created.id}`);
            },
            onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the user.'),
        });
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>New user</DialogTitle>
                    <DialogDescription>Grants console or SDK access. Roles and departments are assigned on the user detail.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="create-user-username">
                            Username <span aria-hidden className="text-destructive">*</span>
                        </Label>
                        <Input
                            id="create-user-username"
                            value={username}
                            onChange={(event) => setUsername(event.target.value)}
                            placeholder="mia.okafor"
                            autoComplete="off"
                            required
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="create-user-password">
                            Password <span aria-hidden className="text-destructive">*</span>
                        </Label>
                        <Input
                            id="create-user-password"
                            type="password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            autoComplete="new-password"
                            required
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="create-user-email">Email</Label>
                        <Input
                            id="create-user-email"
                            type="email"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            placeholder="mia@example.org"
                            autoComplete="off"
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="create-user-external-id">External ID</Label>
                        <Input
                            id="create-user-external-id"
                            value={externalId}
                            onChange={(event) => setExternalId(event.target.value)}
                            placeholder="Directory / SSO identifier"
                            autoComplete="off"
                            className="font-mono"
                        />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex flex-col gap-0.5">
                            <Label htmlFor="create-user-service-account">Service account</Label>
                            <p className="text-muted-foreground text-xs">Machine identity for API keys and integrations.</p>
                        </div>
                        <Switch id="create-user-service-account" checked={serviceAccount} onCheckedChange={setServiceAccount} />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!valid || createUser.isPending}>
                            {createUser.isPending ? <Spinner /> : null}
                            Create user
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
