'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@arcaai/ui/components/shadcn/dialog';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { useDeleteUser, useResetPassword, useUpdateUserStatus } from '../api/hooks';
import type { ResetPasswordResult, User } from '../api/types';

export type UserAction = 'enable' | 'disable' | 'delete' | 'reset-password' | 'impersonate';

export interface UserActionRequest {
    action: UserAction;
    user: Pick<User, 'id' | 'username'>;
}

function errorMessage(error: unknown): string {
    if (error instanceof GatewayError) return error.message;
    return 'The action failed. Try again.';
}

/** The one-time secret a reset produced (link or temporary password). */
function ResetResultDialog({ result, onClose }: { result: ResetPasswordResult | null; onClose: () => void }) {
    const secret = result?.mode === 'temporary' ? result.temporaryPassword : (result?.resetPath ?? result?.token);
    return (
        <Dialog open={result !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{result?.mode === 'temporary' ? 'Temporary password set' : 'Password reset link created'}</DialogTitle>
                    <DialogDescription>
                        Share it with the user out-of-band — it is shown only once.
                        {result?.mode !== 'temporary' ? ` Email sent: ${result?.emailSent ? 'yes' : 'no'}.` : null}
                    </DialogDescription>
                </DialogHeader>
                <div className="bg-muted/50 flex items-center gap-1 rounded-md border p-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs">{secret ?? '\u2014'}</code>
                    {secret ? <CopyButton value={secret} label="Copy reset secret" /> : null}
                </div>
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose}>
                        Done
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * The user actions behind their confirm dialogs (frame 05 pattern): status
 * flips and reset-password use a plain confirm, delete requires typing the
 * username, and the impersonation entry (matrix row 16) confirms the audit
 * posture before POSTing to the BFF's own /api/auth route — the only call
 * allowed to bypass the /api/hope proxy, because it rewrites the session
 * cookie. Callers own WHICH action is requested; this component owns the
 * mutations and toasts.
 */
export function UserActionDialogs({
    request,
    onOpenChange,
    onDeleted,
}: {
    request: UserActionRequest | null;
    onOpenChange: (open: boolean) => void;
    /** Detail screens navigate away after a delete; lists just refresh. */
    onDeleted?: () => void;
}) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const updateStatus = useUpdateUserStatus();
    const deleteUser = useDeleteUser();
    const resetPassword = useResetPassword();
    const [impersonatePending, setImpersonatePending] = useState(false);
    const [resetResult, setResetResult] = useState<ResetPasswordResult | null>(null);

    if (!request && !resetResult) return null;

    function close() {
        onOpenChange(false);
    }

    function handleStatus(resourceStatus: 'ENABLED' | 'DISABLED', success: string) {
        if (!request) return;
        updateStatus.mutate(
            { id: request.user.id, resourceStatus },
            {
                onSuccess: () => {
                    toast.success(success);
                    close();
                },
                onError: (error) => toast.error(errorMessage(error)),
            },
        );
    }

    function handleDelete() {
        if (!request) return;
        deleteUser.mutate(request.user.id, {
            onSuccess: () => {
                toast.success('User deleted');
                close();
                onDeleted?.();
            },
            onError: (error) => toast.error(errorMessage(error)),
        });
    }

    function handleResetPassword() {
        if (!request) return;
        resetPassword.mutate(
            { id: request.user.id, body: { mode: 'link' } },
            {
                onSuccess: (result) => {
                    toast.success('Password reset link created');
                    close();
                    setResetResult(result);
                },
                onError: (error) => toast.error(errorMessage(error)),
            },
        );
    }

    /**
     * Impersonation MUST go through the BFF auth route (not the gateway
     * proxy): it stores the act-as token in the encrypted session cookie.
     * Every cached query belongs to the previous identity afterwards.
     */
    async function handleImpersonate() {
        if (!request) return;
        setImpersonatePending(true);
        try {
            const response = await fetch('/api/auth/impersonate', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ userId: request.user.id }),
            });
            if (!response.ok) {
                const payload = (await response.json().catch(() => ({}))) as { message?: string };
                toast.error(payload.message ?? 'Impersonation failed');
                return;
            }
            toast.success(`Impersonating ${request.user.username}`);
            close();
            await queryClient.invalidateQueries();
            router.refresh();
        } catch {
            toast.error('Could not reach the server. Please try again.');
        } finally {
            setImpersonatePending(false);
        }
    }

    const username = request?.user.username ?? '';
    const dialogs: Record<UserAction, { title: string; description: string; confirmLabel: string; destructive: boolean; typeToConfirm?: string; isPending: boolean; onConfirm: () => void | Promise<void> }> = {
        enable: {
            title: `Enable ${username}?`,
            description: 'The user can sign in and use the platform again.',
            confirmLabel: 'Enable',
            destructive: false,
            isPending: updateStatus.isPending,
            onConfirm: () => handleStatus('ENABLED', 'User enabled'),
        },
        disable: {
            title: `Disable ${username}?`,
            description: 'The user can no longer sign in. Their data and assignments are kept.',
            confirmLabel: 'Disable',
            destructive: true,
            isPending: updateStatus.isPending,
            onConfirm: () => handleStatus('DISABLED', 'User disabled'),
        },
        delete: {
            title: `Delete ${username}?`,
            description: 'This soft-deletes the user and removes them from every list. Type the username to confirm.',
            confirmLabel: 'Delete user',
            destructive: true,
            typeToConfirm: username,
            isPending: deleteUser.isPending,
            onConfirm: handleDelete,
        },
        'reset-password': {
            title: `Reset password for ${username}?`,
            description:
                'Creates a single-use reset link and emails it to the user when email is configured. The link is also shown here to share out-of-band.',
            confirmLabel: 'Reset password',
            destructive: false,
            isPending: resetPassword.isPending,
            onConfirm: handleResetPassword,
        },
        impersonate: {
            title: `Impersonate ${username}?`,
            description:
                'You will act as this user across the platform until you revoke it from the session banner. Every action taken while impersonating is audit-flagged.',
            confirmLabel: 'Impersonate',
            destructive: false,
            isPending: impersonatePending,
            onConfirm: handleImpersonate,
        },
    };

    return (
        <>
            {request ? <ConfirmDialog open onOpenChange={onOpenChange} {...dialogs[request.action]} /> : null}
            <ResetResultDialog result={resetResult} onClose={() => setResetResult(null)} />
        </>
    );
}
