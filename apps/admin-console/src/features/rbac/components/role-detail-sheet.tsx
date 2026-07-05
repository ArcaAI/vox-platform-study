'use client';

import { useState, type FormEvent } from 'react';
import { IconLink, IconLock, IconPencil, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@arcaai/ui/components/shadcn/select';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from '@arcaai/ui/components/shadcn/sheet';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { BreakGlassDialog, type BreakGlassCredentials } from '@/shared/confirm/break-glass-dialog';
import { CopyButton } from '@/shared/copy-button';
import { formatDateTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useAssignPolicyToRole, useDetachPolicyFromRole, usePolicies, useRole, useUpdateRole } from '../api/hooks';
import type { Role } from '../api/types';
import { RoleTypeBadge } from './roles-screen';

function EditRoleDialog({ role, open, onOpenChange }: { role: Role; open: boolean; onOpenChange: (open: boolean) => void }) {
    const updateRole = useUpdateRole();
    const [name, setName] = useState(role.name);
    const [description, setDescription] = useState(role.description ?? '');
    const occError = updateRole.error instanceof GatewayError && updateRole.error.isVersionConflict ? updateRole.error : null;

    function handleOpenChange(next: boolean) {
        if (!next) {
            setName(role.name);
            setDescription(role.description ?? '');
            updateRole.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        updateRole.mutate(
            {
                id: role.id,
                body: {
                    name: name.trim(),
                    description: description.trim() || undefined,
                },
            },
            {
                onSuccess: () => {
                    toast.success('Role updated');
                    onOpenChange(false);
                },
                onError: (error) => {
                    // A 412 renders the inline OCC alert instead of a toast.
                    if (error instanceof GatewayError && error.isVersionConflict) return;
                    toast.error(error.message);
                },
            },
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Edit role</DialogTitle>
                    <DialogDescription>Rename the role or update its description.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <OccConflictAlert error={occError} onReload={() => updateRole.reset()} />
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="edit-role-name">
                            Name{' '}
                            <span aria-hidden className="text-destructive">
                                *
                            </span>
                        </Label>
                        <Input id="edit-role-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" required />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="edit-role-description">Description</Label>
                        <Textarea
                            id="edit-role-description"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            className="resize-none"
                            rows={3}
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={updateRole.isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!name.trim() || updateRole.isPending}>
                            {updateRole.isPending ? <Spinner /> : null}
                            Save changes
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Attach-policy row: pick from the policies the role does not hold yet. */
function AttachPolicyRow({ role }: { role: Role }) {
    // The RBAC list endpoint caps selection at one page; 100 covers the
    // seeded policy catalog (the surface has no combobox search endpoint).
    const policiesQuery = usePolicies({ page: 1, pageSize: 100 });
    const assignPolicy = useAssignPolicyToRole();
    const [policyId, setPolicyId] = useState('');

    const attachedIds = new Set((role.policies ?? []).map((policy) => policy.id));
    const available = (policiesQuery.data?.data ?? []).filter((policy) => !attachedIds.has(policy.id));

    function handleAttach() {
        if (!policyId) return;
        assignPolicy.mutate(
            { roleId: role.id, policyId },
            {
                onSuccess: () => {
                    toast.success('Policy attached');
                    setPolicyId('');
                },
                onError: (error) => toast.error(error.message),
            },
        );
    }

    return (
        <div className="flex items-center gap-2">
            <Select value={policyId} onValueChange={setPolicyId} disabled={available.length === 0}>
                <SelectTrigger aria-label="Policy to attach" className="min-w-0 flex-1">
                    <SelectValue placeholder={available.length === 0 ? 'No detached policies' : 'Pick a policy\u2026'} />
                </SelectTrigger>
                <SelectContent>
                    {available.map((policy) => (
                        <SelectItem key={policy.id} value={policy.id}>
                            <span className="font-mono text-xs">{policy.name}</span>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <Button variant="outline" disabled={!policyId || assignPolicy.isPending} onClick={handleAttach}>
                {assignPolicy.isPending ? <Spinner /> : <IconLink aria-hidden />}
                Attach policy
            </Button>
        </div>
    );
}

function RoleDetailBody({ role, onDelete }: { role: Role; onDelete: (role: Role) => void }) {
    const detachPolicy = useDetachPolicyFromRole();
    const [editOpen, setEditOpen] = useState(false);
    const [detachTarget, setDetachTarget] = useState<{ id: string; name: string } | null>(null);
    const [detachError, setDetachError] = useState<string | null>(null);
    const policies = role.policies ?? [];
    const locked = role.isSystemRole;

    function closeDetachDialog() {
        setDetachTarget(null);
        setDetachError(null);
        detachPolicy.reset();
    }

    function handleDetachConfirm(credentials: BreakGlassCredentials) {
        if (!detachTarget) return;
        detachPolicy.mutate(
            { roleId: role.id, policyId: detachTarget.id, breakGlass: credentials },
            {
                onSuccess: () => {
                    toast.success('Policy detached');
                    closeDetachDialog();
                },
                onError: (error) => setDetachError(error.message),
            },
        );
    }

    return (
        <>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
                {locked ? (
                    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                        <IconLock aria-hidden className="size-3.5 shrink-0" />
                        System role — seed-managed and read-only. Policies cannot be attached or detached.
                    </p>
                ) : null}
                {role.description ? <p className="text-muted-foreground text-sm">{role.description}</p> : null}
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {role.externalName ? (
                        <>
                            <dt className="text-muted-foreground">External name</dt>
                            <dd className="font-mono text-xs leading-5">{role.externalName}</dd>
                        </>
                    ) : null}
                    {role.externalId ? (
                        <>
                            <dt className="text-muted-foreground">External id</dt>
                            <dd className="font-mono text-xs leading-5">{role.externalId}</dd>
                        </>
                    ) : null}
                    <dt className="text-muted-foreground">Created</dt>
                    <dd>{formatDateTime(role.createdAt)}</dd>
                    <dt className="text-muted-foreground">Updated</dt>
                    <dd>{formatDateTime(role.updatedAt)}</dd>
                </dl>
                <Separator />
                <section aria-label="Attached policies" className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium">Attached policies ({policies.length})</h3>
                    {policies.length === 0 ? (
                        <p className="text-muted-foreground text-sm">No policies attached yet.</p>
                    ) : (
                        <ul className="flex flex-col gap-1">
                            {policies.map((policy) => (
                                <li key={policy.id} className="flex h-10 items-center gap-2 rounded-md border px-3">
                                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{policy.name}</span>
                                    <Badge variant="outline" className="tabular-nums">
                                        priority {policy.priority}
                                    </Badge>
                                    {!locked ? (
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={`Detach ${policy.name}`}
                                            onClick={() => setDetachTarget({ id: policy.id, name: policy.name })}
                                        >
                                            <IconTrash aria-hidden />
                                        </Button>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )}
                    {!locked ? <AttachPolicyRow role={role} /> : null}
                </section>
            </div>
            {!locked ? (
                <SheetFooter className="border-t">
                    <div className="flex justify-end gap-2">
                        <Button variant="outline" onClick={() => setEditOpen(true)}>
                            <IconPencil aria-hidden />
                            Edit role
                        </Button>
                        <Button variant="destructive" onClick={() => onDelete(role)}>
                            <IconTrash aria-hidden />
                            Delete role
                        </Button>
                    </div>
                </SheetFooter>
            ) : null}
            <EditRoleDialog key={`${role.id}-${role.updatedAt}`} role={role} open={editOpen} onOpenChange={setEditOpen} />
            <BreakGlassDialog
                key={detachTarget?.id ?? 'detach-policy'}
                open={detachTarget !== null}
                onOpenChange={(open) => !open && closeDetachDialog()}
                title="Detach policy"
                description={
                    <>
                        Removes <span className="font-mono">{detachTarget?.name}</span> from{' '}
                        <span className="text-foreground font-medium">{role.name}</span>. The gateway matches the exact POLICY name.
                    </>
                }
                confirmationName={detachTarget?.name ?? ''}
                confirmLabel="Detach policy"
                onConfirm={handleDetachConfirm}
                isPending={detachPolicy.isPending}
                error={detachError}
            />
        </>
    );
}

function RoleDetailSkeleton() {
    return (
        <div className="flex flex-col gap-4 p-4">
            <Skeleton className="h-4 w-3/4" />
            <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-48" />
            </div>
            <Skeleton className="h-4 w-32" />
            {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
            ))}
        </div>
    );
}

/**
 * Role detail drawer (frame 21: row click -> role editor). Shows the role's
 * info + attached policies; attach assigns via POST, detach requires the
 * break-glass step-up with the POLICY name as confirmation. Editing and
 * deleting custom roles happen here too (delete confirms the ROLE name via
 * the screen-level dialog).
 */
export function RoleDetailSheet({
    roleId,
    onOpenChange,
    onDelete,
}: {
    roleId: string | null;
    onOpenChange: (open: boolean) => void;
    onDelete: (role: Role) => void;
}) {
    const open = roleId !== null;
    const detail = useRole(roleId ?? '');
    const role = detail.data ?? null;

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl">
                <SheetHeader className="border-b">
                    <SheetTitle className="flex flex-wrap items-center gap-2">
                        {role ? (
                            <>
                                {role.name}
                                <RoleTypeBadge role={role} />
                                <ResourceStatusBadge status={role.resourceStatus} />
                            </>
                        ) : (
                            'Role'
                        )}
                    </SheetTitle>
                    <SheetDescription>Role membership grants every attached policy, highest priority first.</SheetDescription>
                    {role ? (
                        <div className="text-muted-foreground flex items-center gap-1 text-xs">
                            <span className="font-mono">{role.id}</span>
                            <CopyButton value={role.id} label="Copy role id" />
                        </div>
                    ) : null}
                </SheetHeader>
                {!open ? null : detail.isPending ? (
                    <RoleDetailSkeleton />
                ) : detail.error || !role ? (
                    <div className="p-4">
                        <ErrorState
                            error={detail.error ?? new GatewayError(404, 'This role does not exist or is outside your access scope.')}
                            onRetry={() => void detail.refetch()}
                        />
                    </div>
                ) : (
                    <RoleDetailBody key={role.id} role={role} onDelete={onDelete} />
                )}
            </SheetContent>
        </Sheet>
    );
}
