import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { usePolicies, useRoles, type Policy, type Role } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Eye, KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDelete } from '@/features/common/confirm-delete';
import { PageHeader } from '@/components/layout/page-header';
import { resourceStatusLabel, resourceStatusRole } from '@/features/data-grid/status';
import { PolicyFormDialog, type PolicyInput } from '@/features/roles/policy-form-dialog';
import { RoleFormDialog, type RoleFormInput } from '@/features/roles/role-form-dialog';
import { RolePoliciesSheet } from '@/features/roles/role-policies-sheet';
import { rolePolicies, type RoleWithPolicies } from '@/features/roles/types';

export const Route = createFileRoute('/_authenticated/roles')({
    component: RolesPage,
});

function isSystemRole(role: Role): boolean {
    return role.isSystemRole === true;
}

// ── Roles tab ────────────────────────────────────────────────────────────────

function RolesTab() {
    const { roles, isLoading, error, listRoles, createRole, updateRole, deleteRole, assignPolicy, removePolicy } = useRoles();
    const { policies, list: listPolicies } = usePolicies();
    const [editing, setEditing] = useState<Role | null>(null);
    const [managingId, setManagingId] = useState<string | null>(null);
    const [busyPolicyId, setBusyPolicyId] = useState<string | null>(null);

    useEffect(() => {
        void listRoles().catch(() => undefined);
    }, [listRoles]);
    useEffect(() => {
        void listPolicies().catch(() => undefined);
    }, [listPolicies]);

    const roleName = (id?: string | null) => (id ? roles.find((r) => r.id === id)?.name ?? id : '—');
    const managingRole = (managingId ? roles.find((r) => r.id === managingId) ?? null : null) as RoleWithPolicies | null;

    const onCreate = async (input: RoleFormInput) => {
        try {
            await createRole({ name: input.name, description: input.description, parentRoleId: input.parentRoleId ?? undefined });
            toast.success('Role created');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to create role');
            throw err;
        }
    };

    const onUpdate = async (input: RoleFormInput) => {
        if (!editing) return;
        try {
            await updateRole(editing.id, { name: input.name, description: input.description, parentRoleId: input.parentRoleId });
            toast.success('Role updated');
            setEditing(null);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update role');
            throw err;
        }
    };

    const onDelete = async (role: Role) => {
        try {
            await deleteRole(role.id);
            toast.success('Role deleted');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete role');
        }
    };

    const onAttach = async (policyId: string) => {
        if (!managingId) return;
        setBusyPolicyId(policyId);
        try {
            await assignPolicy(managingId, policyId);
            await listRoles();
            toast.success('Policy attached');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to attach policy');
        } finally {
            setBusyPolicyId(null);
        }
    };

    const onDetach = async (policyId: string) => {
        if (!managingId) return;
        setBusyPolicyId(policyId);
        try {
            await removePolicy(managingId, policyId);
            await listRoles();
            toast.success('Policy detached');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to detach policy');
        } finally {
            setBusyPolicyId(null);
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex justify-end">
                <RoleFormDialog
                    mode="create"
                    roles={roles}
                    onSave={onCreate}
                    trigger={
                        <Button>
                            <Plus className="size-4" />
                            New role
                        </Button>
                    }
                />
            </div>
            {error ? (
                <Alert variant="destructive">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Couldn’t load roles</AlertTitle>
                    <AlertDescription>{error.message}</AlertDescription>
                </Alert>
            ) : null}
            <div className="rounded-lg border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Description</TableHead>
                            <TableHead>Parent</TableHead>
                            <TableHead className="text-right">Policies</TableHead>
                            <TableHead className="w-28 text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {isLoading && roles.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                                    Loading…
                                </TableCell>
                            </TableRow>
                        ) : roles.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                                    No roles yet.
                                </TableCell>
                            </TableRow>
                        ) : (
                            roles.map((role) => (
                                <TableRow key={role.id}>
                                    <TableCell>
                                        <div className="flex items-center gap-2 font-medium">
                                            {role.name}
                                            {isSystemRole(role) ? <StatusBadge label="System" colorRole="hope" icon={<ShieldCheck />} /> : null}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">{role.description || '—'}</TableCell>
                                    <TableCell className="text-muted-foreground">{roleName(role.parentRoleId)}</TableCell>
                                    <TableCell className="text-right tabular-nums">{rolePolicies(role).length}</TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex justify-end gap-1">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="size-8"
                                                onClick={() => setManagingId(role.id)}
                                                aria-label={`Manage policies for ${role.name}`}
                                            >
                                                <KeyRound className="size-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="size-8"
                                                onClick={() => setEditing(role)}
                                                disabled={isSystemRole(role)}
                                                aria-label={`Edit ${role.name}`}
                                            >
                                                <Pencil className="size-4" />
                                            </Button>
                                            <ConfirmDelete
                                                trigger={
                                                    <Button variant="ghost" size="icon" className="size-8" disabled={isSystemRole(role)} aria-label={`Delete ${role.name}`}>
                                                        <Trash2 className="size-4" />
                                                    </Button>
                                                }
                                                title={`Delete role “${role.name}”?`}
                                                description="Users assigned this role will lose its policies. This cannot be undone."
                                                onConfirm={() => onDelete(role)}
                                            />
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>

            <RoleFormDialog mode="edit" initial={editing} roles={roles} onSave={onUpdate} open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} />
            <RolePoliciesSheet
                role={managingRole}
                allPolicies={policies}
                open={managingId !== null}
                onOpenChange={(o) => !o && setManagingId(null)}
                onAttach={onAttach}
                onDetach={onDetach}
                busyPolicyId={busyPolicyId}
            />
        </div>
    );
}

// ── Policies tab ───────────────────────────────────────────────────────────────

function PolicyViewDialog({ policy, open, onOpenChange }: { policy: Policy | null; open: boolean; onOpenChange: (open: boolean) => void }) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{policy?.name ?? 'Policy'}</DialogTitle>
                    <DialogDescription>{policy?.description || 'CASL ability rules'}</DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                    <div className="flex gap-2 text-sm text-muted-foreground">
                        <span>Scope:</span>
                        <span className="font-mono text-foreground">{policy?.scope || '—'}</span>
                    </div>
                    <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">{JSON.stringify(policy?.rules ?? [], null, 2)}</pre>
                </div>
                <DialogFooter>
                    <DialogClose asChild>
                        <Button variant="outline">Close</Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function PoliciesTab() {
    const { policies, isLoading, error, list, create, update, validate, remove } = usePolicies();
    const [viewing, setViewing] = useState<Policy | null>(null);
    const [editing, setEditing] = useState<Policy | null>(null);

    useEffect(() => {
        void list().catch(() => undefined);
    }, [list]);

    const onCreate = async (input: PolicyInput) => {
        await create(input);
        toast.success('Policy created');
    };

    const onUpdate = async (input: PolicyInput) => {
        if (!editing) return;
        await update(editing.id, input);
        toast.success('Policy updated');
        setEditing(null);
    };

    const onDelete = async (policy: Policy) => {
        try {
            await remove(policy.id);
            toast.success('Policy deleted');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete policy');
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex justify-end">
                <PolicyFormDialog
                    mode="create"
                    onSave={onCreate}
                    onValidate={validate}
                    trigger={
                        <Button>
                            <Plus className="size-4" />
                            New policy
                        </Button>
                    }
                />
            </div>
            {error ? (
                <Alert variant="destructive">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Couldn’t load policies</AlertTitle>
                    <AlertDescription>{error.message}</AlertDescription>
                </Alert>
            ) : null}
            <div className="rounded-lg border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Scope</TableHead>
                            <TableHead className="text-right">Rules</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="w-32 text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {isLoading && policies.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                                    Loading…
                                </TableCell>
                            </TableRow>
                        ) : policies.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                                    No policies yet.
                                </TableCell>
                            </TableRow>
                        ) : (
                            policies.map((policy) => (
                                <TableRow key={policy.id}>
                                    <TableCell className="font-medium">{policy.name}</TableCell>
                                    <TableCell className="text-muted-foreground">{policy.scope || '—'}</TableCell>
                                    <TableCell className="text-right tabular-nums">{policy.rules?.length ?? 0}</TableCell>
                                    <TableCell>
                                        <StatusBadge label={resourceStatusLabel(policy.resourceStatus)} colorRole={resourceStatusRole(policy.resourceStatus)} />
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex justify-end gap-1">
                                            <Button variant="ghost" size="icon" className="size-8" onClick={() => setViewing(policy)} aria-label={`View ${policy.name}`}>
                                                <Eye className="size-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" className="size-8" onClick={() => setEditing(policy)} aria-label={`Edit ${policy.name}`}>
                                                <Pencil className="size-4" />
                                            </Button>
                                            <ConfirmDelete
                                                trigger={
                                                    <Button variant="ghost" size="icon" className="size-8" aria-label={`Delete ${policy.name}`}>
                                                        <Trash2 className="size-4" />
                                                    </Button>
                                                }
                                                title={`Delete policy “${policy.name}”?`}
                                                description="Roles referencing this policy will lose its rules. This cannot be undone."
                                                onConfirm={() => onDelete(policy)}
                                            />
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>
            <PolicyViewDialog policy={viewing} open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)} />
            <PolicyFormDialog
                mode="edit"
                initial={editing}
                open={editing !== null}
                onOpenChange={(o) => !o && setEditing(null)}
                onSave={onUpdate}
                onValidate={validate}
            />
        </div>
    );
}

function RolesPage() {
    return (
        <div>
            <PageHeader title="Roles & Policies" description="Role-based access control and CASL ability policies for your tenant." />
            <Tabs defaultValue="roles">
                <TabsList>
                    <TabsTrigger value="roles">Roles</TabsTrigger>
                    <TabsTrigger value="policies">Policies</TabsTrigger>
                </TabsList>
                <TabsContent value="roles" className="mt-4">
                    <RolesTab />
                </TabsContent>
                <TabsContent value="policies" className="mt-4">
                    <PoliciesTab />
                </TabsContent>
            </Tabs>
        </div>
    );
}
