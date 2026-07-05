'use client';

import { toast } from 'sonner';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { useArchiveTenant, useDeleteTenant, useRestoreTenant, useSuspendTenant } from '../api/hooks';
import type { Tenant } from '../api/types';

export type LifecycleAction = 'suspend' | 'archive' | 'restore' | 'delete';

export interface LifecycleRequest {
    action: LifecycleAction;
    tenant: Tenant;
}

interface LifecycleCopy {
    description: string;
    confirmLabel: string;
    destructive: boolean;
    success: string;
}

const COPY: Record<LifecycleAction, LifecycleCopy> = {
    suspend: {
        description: 'Users of this tenant lose access until it is restored.',
        confirmLabel: 'Suspend',
        destructive: true,
        success: 'Tenant suspended',
    },
    archive: {
        description: 'The tenant is hidden from active use. Its data is retained and it can be restored later.',
        confirmLabel: 'Archive',
        destructive: true,
        success: 'Tenant archived',
    },
    restore: {
        description: 'The tenant returns to active service.',
        confirmLabel: 'Restore',
        destructive: false,
        success: 'Tenant restored',
    },
    delete: {
        description: 'This soft-deletes the tenant and removes it from every list. Type the tenant name to confirm.',
        confirmLabel: 'Delete tenant',
        destructive: true,
        success: 'Tenant deleted',
    },
};

const TITLES: Record<LifecycleAction, (name: string) => string> = {
    suspend: (name) => `Suspend ${name}?`,
    archive: (name) => `Archive ${name}?`,
    restore: (name) => `Restore ${name}?`,
    delete: (name) => `Delete ${name}?`,
};

function errorMessage(error: unknown): string {
    if (error instanceof GatewayError) return error.message;
    return 'The action failed. Try again.';
}

/**
 * The four tenant lifecycle transitions behind their confirm dialogs (frame
 * 05 pattern): every action confirms; delete additionally requires typing the
 * tenant name. Callers own WHICH action is requested; this component owns the
 * mutations and toasts.
 */
export function TenantLifecycleDialogs({
    request,
    onOpenChange,
    onDeleted,
}: {
    request: LifecycleRequest | null;
    onOpenChange: (open: boolean) => void;
    /** Detail screens navigate away after a delete; lists just refresh. */
    onDeleted?: () => void;
}) {
    const suspend = useSuspendTenant();
    const archive = useArchiveTenant();
    const restore = useRestoreTenant();
    const remove = useDeleteTenant();

    if (!request) return null;

    const mutations = { suspend, archive, restore, delete: remove } as const;
    const mutation = mutations[request.action];
    const copy = COPY[request.action];

    function handleConfirm() {
        if (!request) return;
        mutation.mutate(request.tenant.id, {
            onSuccess: () => {
                toast.success(copy.success);
                onOpenChange(false);
                if (request.action === 'delete') onDeleted?.();
            },
            onError: (error) => toast.error(errorMessage(error)),
        });
    }

    return (
        <ConfirmDialog
            open
            onOpenChange={onOpenChange}
            title={TITLES[request.action](request.tenant.name)}
            description={copy.description}
            confirmLabel={copy.confirmLabel}
            destructive={copy.destructive}
            typeToConfirm={request.action === 'delete' ? request.tenant.name : undefined}
            isPending={mutation.isPending}
            onConfirm={handleConfirm}
        />
    );
}
