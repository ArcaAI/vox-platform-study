import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { usePolicies, useRoles, type BreakGlassCredentials, type Policy, type Role } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Eye, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { resourceStatusLabel, resourceStatusRole } from '@/features/data-grid/status';
import { BreakGlassDialog, isBreakGlassRequired, type BreakGlassResult } from '@/features/roles/break-glass-dialog';
import { PermissionMatrix } from '@/features/roles/permission-matrix';
import { PolicyFormDialog, type PolicyInput } from '@/features/roles/policy-form-dialog';
import { RoleFormDialog, type RoleFormInput } from '@/features/roles/role-form-dialog';
import { RolePoliciesSheet } from '@/features/roles/role-policies-sheet';
import { RolesBrowser } from '@/features/roles/roles-browser';
import { isProtectedSystemPolicy, PROTECTED_POLICY_REASON } from '@/features/roles/protected-policies';
import { rolePolicies, type RoleWithPolicies } from '@/features/roles/types';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { requireSuperAdmin } from '@/lib/route-guards';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_authenticated/roles')({
  beforeLoad: ({ context }) => requireSuperAdmin(context),
  component: RolesPage,
});

// ── Roles tab ────────────────────────────────────────────────────────────────

function RolesTab() {
  const { roles, isLoading, error, listRoles, createRole, updateRole, deleteRole, assignPolicy, removePolicy } = useRoles();
  const { policies, list: listPolicies } = usePolicies();
  const [editing, setEditing] = useState<Role | null>(null);
  const [managingId, setManagingId] = useState<string | null>(null);
  const [busyPolicyId, setBusyPolicyId] = useState<string | null>(null);
  // TASK-409 — break-glass targets (role deletion / policy detach).
  const [deletingRole, setDeletingRole] = useState<RoleWithPolicies | null>(null);
  const [detaching, setDetaching] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    void listRoles().catch(() => undefined);
  }, [listRoles]);
  useEffect(() => {
    void listPolicies().catch(() => undefined);
  }, [listPolicies]);

  const managingRole = (managingId ? (roles.find((r) => r.id === managingId) ?? null) : null) as RoleWithPolicies | null;

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

  // TASK-409 — role deletion requires break-glass (type name + password);
  // the dialog performs the actual call and shows server rejections inline.
  const onDeleteConfirm = async (credentials: BreakGlassCredentials): Promise<BreakGlassResult> => {
    if (!deletingRole) return { ok: false, message: 'No role selected.' };
    try {
      await deleteRole(deletingRole.id, credentials);
      toast.success('Role deleted');
      setDeletingRole(null);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Failed to delete role' };
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

  // TASK-409 — detach now opens the break-glass dialog instead of firing
  // immediately; the confirmed credentials ride along on the DELETE.
  const onDetach = async (policyId: string) => {
    const managed = managingRole ? rolePolicies(managingRole).find((p) => p.id === policyId) : undefined;
    const name = managed?.name || policies.find((p) => p.id === policyId)?.name || policyId;
    setDetaching({ id: policyId, name });
  };

  const onDetachConfirm = async (credentials: BreakGlassCredentials): Promise<BreakGlassResult> => {
    if (!managingId || !detaching) return { ok: false, message: 'No policy selected.' };
    setBusyPolicyId(detaching.id);
    try {
      await removePolicy(managingId, detaching.id, credentials);
      await listRoles();
      toast.success('Policy detached');
      setDetaching(null);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Failed to detach policy' };
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
      <RolesBrowser
        roles={roles}
        policies={policies}
        isLoading={isLoading}
        onEdit={(role) => setEditing(role)}
        onManagePolicies={(role) => setManagingId(role.id)}
        onDelete={(role) => setDeletingRole(role)}
      />

      <RoleFormDialog
        mode="edit"
        initial={editing}
        roles={roles}
        onSave={onUpdate}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
      <RolePoliciesSheet
        role={managingRole}
        allPolicies={policies}
        open={managingId !== null}
        onOpenChange={(o) => !o && setManagingId(null)}
        onAttach={onAttach}
        onDetach={onDetach}
        busyPolicyId={busyPolicyId}
      />

      {/* TASK-409 — break-glass confirmations. */}
      <BreakGlassDialog
        open={deletingRole !== null}
        onOpenChange={(o) => !o && setDeletingRole(null)}
        title="Delete role"
        description="Users assigned this role will lose its policies. This cannot be undone."
        expectedName={deletingRole?.name ?? ''}
        confirmLabel="Delete role"
        onConfirm={onDeleteConfirm}
      />
      <BreakGlassDialog
        open={detaching !== null}
        onOpenChange={(o) => !o && setDetaching(null)}
        title="Detach policy"
        description={`Detaching removes this policy's rules from “${managingRole?.name ?? 'the role'}”. Members holding only this role lose those permissions immediately.`}
        expectedName={detaching?.name ?? ''}
        confirmLabel="Detach policy"
        onConfirm={onDetachConfirm}
      />
    </div>
  );
}

// ── Policies tab ───────────────────────────────────────────────────────────────

function PolicyViewDialog({ policy, open, onOpenChange }: { policy: Policy | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-3xl', MOBILE_DIALOG_CONTENT)}>
        <DialogHeader>
          <DialogTitle>{policy?.name ?? 'Policy'}</DialogTitle>
          <DialogDescription>{policy?.description || 'CASL ability rules'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2 text-sm text-muted-foreground">
            <span>Scope:</span>
            <span className="font-mono text-foreground">{policy?.scope || '—'}</span>
          </div>
          {/* TASK-395 P1-3 (§5.1 24b) — SUBJECTS × ACTIONS permission matrix. */}
          <PermissionMatrix rules={policy?.rules} />
          <details className="rounded-md border bg-muted/40">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">Raw CASL JSON</summary>
            <pre className="max-h-72 overflow-auto border-t px-3 py-2 text-xs">{JSON.stringify(policy?.rules ?? [], null, 2)}</pre>
          </details>
        </div>
        <DialogFooter className={MOBILE_DIALOG_FOOTER}>
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
  // TASK-409 — break-glass targets: unprotected policy deletion (always) and
  // rule edits the server answered with 428 (policy attached to >1 role).
  const [deleting, setDeleting] = useState<Policy | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{ policy: Policy; input: PolicyInput } | null>(null);

  useEffect(() => {
    void list().catch(() => undefined);
  }, [list]);

  const onCreate = async (input: PolicyInput) => {
    await create(input);
    toast.success('Policy created');
  };

  const onUpdate = async (input: PolicyInput) => {
    if (!editing) return;
    try {
      await update(editing.id, input);
      toast.success('Policy updated');
      setEditing(null);
    } catch (err) {
      // TASK-409 — the server requires step-up confirmation for rule edits
      // of policies attached to >1 role. Escalate to the break-glass dialog
      // (the form dialog closes; the edit is retried with credentials).
      if (isBreakGlassRequired(err)) {
        setPendingEdit({ policy: editing, input });
        setEditing(null);
        return;
      }
      throw err;
    }
  };

  const onEditConfirm = async (credentials: BreakGlassCredentials): Promise<BreakGlassResult> => {
    if (!pendingEdit) return { ok: false, message: 'No pending edit.' };
    try {
      await update(pendingEdit.policy.id, { ...pendingEdit.input, breakGlass: credentials });
      toast.success('Policy updated');
      setPendingEdit(null);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Failed to update policy' };
    }
  };

  const onDeleteConfirm = async (credentials: BreakGlassCredentials): Promise<BreakGlassResult> => {
    if (!deleting) return { ok: false, message: 'No policy selected.' };
    try {
      await remove(deleting.id, credentials);
      toast.success('Policy deleted');
      setDeleting(null);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Failed to delete policy' };
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
              policies.map((policy) => {
                const protectedPolicy = isProtectedSystemPolicy(policy);
                return (
                  <TableRow key={policy.id}>
                    <TableCell>
                      <div className="flex items-center gap-2 font-medium">
                        {policy.name}
                        {protectedPolicy ? <StatusBadge label="Protected" colorRole="hope" icon={<ShieldCheck />} /> : null}
                      </div>
                    </TableCell>
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
                        {protectedPolicy ? (
                          // TASK-391 #22 — the server refuses to delete/disable this policy
                          // (anti-lockout). Mirror that: disable Delete + explain why, rather
                          // than offer an action the API would 403.
                          <span title={PROTECTED_POLICY_REASON} className="inline-flex">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              disabled
                              aria-label={`Delete ${policy.name} (protected system policy — cannot be deleted)`}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </span>
                        ) : (
                          // TASK-409 — deletion requires break-glass (type name +
                          // password); the dialog IS the confirmation step.
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => setDeleting(policy)}
                            aria-label={`Delete ${policy.name}`}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
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

      {/* TASK-409 — break-glass confirmations. */}
      <BreakGlassDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete policy"
        description="Roles referencing this policy will lose its rules. This cannot be undone."
        expectedName={deleting?.name ?? ''}
        confirmLabel="Delete policy"
        onConfirm={onDeleteConfirm}
      />
      <BreakGlassDialog
        open={pendingEdit !== null}
        onOpenChange={(o) => !o && setPendingEdit(null)}
        title="Confirm rule change"
        description={`“${pendingEdit?.policy.name ?? 'This policy'}” is attached to more than one role — editing its rules changes permissions for every member of those roles.`}
        expectedName={pendingEdit?.policy.name ?? ''}
        confirmLabel="Apply rule change"
        onConfirm={onEditConfirm}
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
