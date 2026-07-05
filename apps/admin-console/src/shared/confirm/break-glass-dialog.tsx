'use client';

import { useId, useState, type ReactNode } from 'react';
import { IconShieldLock } from '@tabler/icons-react';
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

/**
 * Step-up credentials sent in the mutation body (structurally identical to
 * the rbac feature's BreakGlass type — declared here so shared code never
 * imports from a feature module).
 */
export interface BreakGlassCredentials {
    password: string;
    confirmationName: string;
}

export interface BreakGlassDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: ReactNode;
    description: ReactNode;
    /** The exact resource name the gateway matches (400 on mismatch). */
    confirmationName: string;
    confirmLabel: string;
    onConfirm: (credentials: BreakGlassCredentials) => void | Promise<void>;
    isPending?: boolean;
    /** Gateway rejection (401 wrong password, 400 name mismatch, 403 protected). */
    error?: string | null;
}

/**
 * Break-glass step-up (matrix rows 17/18, TASK-409): destructive RBAC
 * operations re-collect the admin password and the target's exact name, sent
 * in the request BODY. Missing credentials -> 428 server-side.
 */
export function BreakGlassDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmationName,
    confirmLabel,
    onConfirm,
    isPending = false,
    error,
}: BreakGlassDialogProps) {
    const [password, setPassword] = useState('');
    const [typedName, setTypedName] = useState('');
    const passwordId = useId();
    const nameId = useId();
    const armed = password.length > 0 && typedName === confirmationName;

    function handleOpenChange(next: boolean) {
        if (!next) {
            setPassword('');
            setTypedName('');
        }
        onOpenChange(next);
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <IconShieldLock aria-hidden className="text-destructive size-5" />
                        {title}
                    </DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={passwordId}>Your password</Label>
                        <Input
                            id={passwordId}
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={nameId}>
                            Type <span className="font-mono font-semibold">{confirmationName}</span> to confirm
                        </Label>
                        <Input id={nameId} value={typedName} onChange={(event) => setTypedName(event.target.value)} autoComplete="off" />
                    </div>
                    {error ? (
                        <p role="alert" className="text-destructive text-sm">
                            {error}
                        </p>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button variant="outline" disabled={isPending} onClick={() => handleOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={!armed || isPending}
                        onClick={() => void onConfirm({ password, confirmationName: typedName })}
                    >
                        {isPending ? <Spinner /> : null}
                        {confirmLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
