'use client';

import { useState, type FormEvent } from 'react';
import { IconCopy, IconLink, IconLock, IconPencil, IconTrash, IconUsersGroup } from '@tabler/icons-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { useSession } from '@/shared/auth';
import { BreakGlassDialog, type BreakGlassCredentials } from '@/shared/confirm/break-glass-dialog';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import type { ViewportTier } from '@/shared/layout/use-viewport-tier';
import { formatDateTime, formatNumber } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useAssignPolicyToRole, useCloneRole, useDetachPolicyFromRole, usePolicies, useRole, useRoleMembers, useUpdateRole } from '../api/hooks';
import type { Role } from '../api/types';
import { derivePermissionMatrix, type MatrixPolicyInput } from '../lib/permission-matrix';
import { PermissionMatrix, PermissionMatrixSkeleton } from './permission-matrix';
import { MemberCountBadge, RoleTypeBadge } from './roles-screen';

type RoleTab = 'permissions' | 'members' | 'policies';

const ROLE_TABS = ['permissions', 'members', 'policies'] as const;

const TAB_DEFS: { value: RoleTab; label: string }[] = [
  { value: 'permissions', label: 'Permissions' },
  { value: 'members', label: 'Members' },
  { value: 'policies', label: 'Policies' },
];

/** Active detail tab in the URL (`?tab=`), shared by the desktop pane and the compact drawer. */
function useRoleTab() {
  return useQueryState('tab', parseAsStringLiteral(ROLE_TABS).withDefault('permissions'));
}

/**
 * SYSTEM-role policy assign/revoke is global-admin only; the
 * effective identity (impersonation-aware) drives the lock so the
 * UI matches what the gateway will actually accept.
 */
function useIsGlobalAdmin() {
  const session = useSession();
  return session.data?.effectiveIsElevated ?? false;
}

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
      { id: role.id, body: { name: name.trim(), description: description.trim() || undefined } },
      {
        onSuccess: () => {
          toast.success('Role updated');
          onOpenChange(false);
        },
        onError: (error) => {
          // 412 renders the inline OCC alert (edits preserved), not a toast.
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

/** Permissions tab — derived, read-only matrix joined from the attached policies' rules. */
function PermissionsTabPanel({ role, tier }: { role: Role; tier: ViewportTier }) {
  // The role's `policies[]` carry only { id, name, priority }; the rules live
  // on the full Policy. Fetch the catalog once (100 covers the seeded set) and
  // join by id, preserving each attachment's priority.
  const policiesQuery = usePolicies({ page: 1, pageSize: 100 });
  const attached = role.policies ?? [];

  if (policiesQuery.isPending && attached.length > 0) {
    return <PermissionMatrixSkeleton />;
  }
  if (policiesQuery.error) {
    return <ErrorState title="Couldn’t load policy rules" error={policiesQuery.error} onRetry={() => void policiesQuery.refetch()} />;
  }

  const catalog = policiesQuery.data?.data ?? [];
  const inputs: MatrixPolicyInput[] = attached
    .map((ref): MatrixPolicyInput | null => {
      const full = catalog.find((policy) => policy.id === ref.id);
      if (!full) return null;
      return {
        id: full.id,
        name: full.name,
        scope: full.scope,
        isProtected: full.isProtected,
        priority: ref.priority,
        rules: full.rules ?? [],
      };
    })
    .filter((entry): entry is MatrixPolicyInput => entry !== null);

  const matrix = derivePermissionMatrix(inputs);

  return (
    <div className="flex flex-col gap-3">
      {attached.length === 0 ? (
        <p className="text-muted-foreground text-sm">No policies attached — this role grants nothing. Attach policies from the Policies tab.</p>
      ) : null}
      <PermissionMatrix data={matrix} layout={tier === 'mobile' ? 'cards' : 'table'} />
    </div>
  );
}

const MEMBERS_PAGE_SIZE = 50;

function MembersSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

/**
 * Members tab — the users holding this role (`GET admin/rbac/roles/:id/members`). The gateway tenant-scopes the rows, so
 * a tenant admin sees only their tenant's members; role changes stay on the
 * Users screen (assign/remove is a per-user operation there).
 */
function MembersTabPanel({ role }: { role: Role }) {
  const [page, setPage] = useState(1);
  const membersQuery = useRoleMembers(role.id, { page, pageSize: MEMBERS_PAGE_SIZE });

  if (membersQuery.isPending) return <MembersSkeleton />;
  if (membersQuery.error) {
    return <ErrorState title="Couldn’t load members" error={membersQuery.error} onRetry={() => void membersQuery.refetch()} />;
  }

  const members = membersQuery.data?.data ?? [];
  const total = membersQuery.data?.total ?? 0;
  if (total === 0) {
    return (
      <EmptyState
        icon={IconUsersGroup}
        title="No members yet"
        description="No users hold this role in your scope. Assign it to a user from the Users screen."
      />
    );
  }

  const pageCount = Math.max(1, Math.ceil(total / MEMBERS_PAGE_SIZE));
  return (
    <section aria-label="Members" className="flex flex-col gap-3">
      <h3 className="text-sm font-medium tabular-nums">Members ({formatNumber(total)})</h3>
      <ul aria-label="Role members" className="flex flex-col gap-1">
        {members.map((member) => {
          // Skip the secondary line when it would just repeat the name
          // (service accounts without a profile).
          const secondary = member.email ?? (member.username !== member.displayName ? member.username : null);
          return (
            <li key={member.assignmentId} className="flex items-center gap-2 rounded-md border px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{member.displayName}</span>
                {secondary ? <span className="text-muted-foreground truncate text-xs">{secondary}</span> : null}
              </div>
              {member.department ? <Badge variant="outline">{member.department}</Badge> : null}
              <ResourceStatusBadge status={member.resourceStatus} />
            </li>
          );
        })}
      </ul>
      {pageCount > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            Page {page} of {pageCount}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1 || membersQuery.isFetching} onClick={() => setPage((current) => current - 1)}>
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount || membersQuery.isFetching}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Attach-policy row: pick from the policies the role does not hold yet. */
function AttachPolicyRow({ role }: { role: Role }) {
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
          <SelectValue placeholder={available.length === 0 ? 'No detached policies' : 'Pick a policy…'} />
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

/** Policies tab — attach/detach (detach = break-glass step-up on the POLICY name). */
function PoliciesTabPanel({ role }: { role: Role }) {
  const detachPolicy = useDetachPolicyFromRole();
  const [detachTarget, setDetachTarget] = useState<{ id: string; name: string } | null>(null);
  const [detachError, setDetachError] = useState<string | null>(null);
  const policies = role.policies ?? [];
  const isGlobalAdmin = useIsGlobalAdmin();
  const locked = role.isSystemRole && !isGlobalAdmin;

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
        // Break-glass rejections (401/400/403) surface in-dialog, not as a toast.
        onError: (error) => setDetachError(error.message),
      },
    );
  }

  return (
    <section aria-label="Attached policies" className="flex flex-col gap-3">
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
      <BreakGlassDialog
        key={detachTarget?.id ?? 'detach-policy'}
        open={detachTarget !== null}
        onOpenChange={(open) => !open && closeDetachDialog()}
        title="Detach policy"
        description={
          <>
            Removes <span className="font-mono">{detachTarget?.name}</span> from <span className="text-foreground font-medium">{role.name}</span>. The
            gateway matches the exact POLICY name.
          </>
        }
        confirmationName={detachTarget?.name ?? ''}
        confirmLabel="Detach policy"
        onConfirm={handleDetachConfirm}
        isPending={detachPolicy.isPending}
        error={detachError}
      />
    </section>
  );
}

/**
 * Clone is always offered — cloning a SYSTEM role into an editable CUSTOM
 * copy is the point. Edit unlocks for a global admin on a SYSTEM
 * role too (matches the service-layer `isSuperAdmin` carve-out on
 * update/patch). Delete stays hidden for EVERY system role, EVERY caller —
 * `softDelete()` is hard-blocked platform-wide, deleting a seed-managed role
 * shared across every tenant is irreversible and out of scope even for a
 * global admin (confirmed decision, see the ticket README).
 */
function RoleDetailActions({
  role,
  onEdit,
  onRequestDelete,
  onClone,
}: {
  role: Role;
  onEdit: () => void;
  onRequestDelete: (role: Role) => void;
  onClone: () => void;
}) {
  const isGlobalAdmin = useIsGlobalAdmin();
  const canEdit = !role.isSystemRole || isGlobalAdmin;
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={onClone}>
        <IconCopy aria-hidden />
        Clone
      </Button>
      {canEdit ? (
        <Button variant="outline" size="sm" onClick={onEdit}>
          <IconPencil aria-hidden />
          Edit
        </Button>
      ) : null}
      {!role.isSystemRole ? (
        <Button variant="destructive" size="sm" onClick={() => onRequestDelete(role)}>
          <IconTrash aria-hidden />
          Delete
        </Button>
      ) : null}
    </div>
  );
}

/** Prefills "{source.name} (copy)"; lands the caller on the new role via onCloned. */
function CloneRoleDialog({
  role,
  open,
  onOpenChange,
  onCloned,
}: {
  role: Role;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloned: (role: Role) => void;
}) {
  const cloneRole = useCloneRole();
  const [name, setName] = useState(`${role.name} (copy)`);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setName(`${role.name} (copy)`);
      cloneRole.reset();
    }
    onOpenChange(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    cloneRole.mutate(
      { id: role.id, body: { name: name.trim() } },
      {
        onSuccess: (cloned) => {
          toast.success('Role cloned');
          handleOpenChange(false);
          onCloned(cloned);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clone role</DialogTitle>
          <DialogDescription>
            Creates a new custom role with a copy of <span className="font-mono">{role.name}</span>&rsquo;s policies.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="clone-role-name">
              Name{' '}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <Input id="clone-role-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" required />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={cloneRole.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || cloneRole.isPending}>
              {cloneRole.isPending ? <Spinner /> : null}
              Clone role
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LockNotice() {
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <IconLock aria-hidden className="size-3.5 shrink-0" />
      System role — seed-managed and read-only. Policies cannot be attached or detached.
    </p>
  );
}

function TabPanels({ role, tier }: { role: Role; tier: ViewportTier }) {
  const isGlobalAdmin = useIsGlobalAdmin();
  return (
    <>
      <TabsContent value="permissions" className="mt-0">
        <PermissionsTabPanel role={role} tier={tier} />
      </TabsContent>
      <TabsContent value="members" className="mt-0">
        <MembersTabPanel role={role} />
      </TabsContent>
      <TabsContent value="policies" className="mt-0">
        {role.isSystemRole && !isGlobalAdmin ? <LockNotice /> : null}
        <div className="mt-3">
          <PoliciesTabPanel role={role} />
        </div>
      </TabsContent>
    </>
  );
}

function RoleTabsList() {
  return (
    <TabsList variant="line">
      {TAB_DEFS.map((tab) => (
        <TabsTrigger key={tab.value} value={tab.value}>
          {tab.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

function RoleMeta({ role }: { role: Role }) {
  return (
    <>
      <span className="font-mono">{role.id}</span>
      <CopyButton value={role.id} label="Copy role id" />
      <span aria-hidden>&middot;</span>
      <span>Updated {formatDateTime(role.updatedAt)}</span>
    </>
  );
}

function RoleDetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-6 w-48" />
      <div className="flex gap-2">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
      <PermissionMatrixSkeleton />
    </div>
  );
}

/**
 * Desktop right pane: the role detail rendered inline in the two-pane layout.
 * Header (name · type · status · Edit/Delete) then Permissions / Members /
 * Policies tabs; only the tab-panel region scrolls.
 */
export function RoleDetailPane({
  roleId,
  tier,
  onRequestDelete,
  onCloned,
}: {
  roleId: string;
  tier: ViewportTier;
  onRequestDelete: (role: Role) => void;
  onCloned: (role: Role) => void;
}) {
  const detail = useRole(roleId);
  const role = detail.data ?? null;
  const [tab, setTab] = useRoleTab();
  const [editOpen, setEditOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const isGlobalAdmin = useIsGlobalAdmin();

  if (detail.isPending) return <RoleDetailSkeleton />;
  if (detail.error || !role) {
    return (
      <ErrorState
        error={detail.error ?? new GatewayError(404, 'This role does not exist or is outside your access scope.')}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{role.name}</h2>
            <RoleTypeBadge role={role} />
            <ResourceStatusBadge status={role.resourceStatus} />
            <MemberCountBadge role={role} />
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <RoleMeta role={role} />
          </div>
          {role.description ? <p className="text-muted-foreground text-sm">{role.description}</p> : null}
          {role.isSystemRole && !isGlobalAdmin ? <LockNotice /> : null}
        </div>
        <RoleDetailActions role={role} onEdit={() => setEditOpen(true)} onRequestDelete={onRequestDelete} onClone={() => setCloneOpen(true)} />
      </div>
      <Separator />
      <Tabs value={tab} onValueChange={(next) => void setTab(next as RoleTab)} className="flex min-h-0 flex-1 flex-col gap-4">
        <RoleTabsList />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TabPanels role={role} tier={tier} />
        </div>
      </Tabs>
      <EditRoleDialog key={`${role.id}-${role.updatedAt}`} role={role} open={editOpen} onOpenChange={setEditOpen} />
      <CloneRoleDialog key={`clone-${role.id}`} role={role} open={cloneOpen} onOpenChange={setCloneOpen} onCloned={onCloned} />
    </div>
  );
}

/**
 * Compact-tier detail: the same content inside the console-wide `DetailDrawer`
 * (full-screen sheet on mobile, right slide-over on tablet). Reuses the shared
 * tab panels; tabs context flows through the Radix portal.
 */
export function RoleDetailDrawer({
  roleId,
  tier,
  onOpenChange,
  onRequestDelete,
  onCloned,
}: {
  roleId: string | null;
  tier: ViewportTier;
  onOpenChange: (open: boolean) => void;
  onRequestDelete: (role: Role) => void;
  onCloned: (role: Role) => void;
}) {
  const open = roleId !== null;
  const detail = useRole(roleId ?? '');
  const role = detail.data ?? null;
  const [tab, setTab] = useRoleTab();
  const [editOpen, setEditOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);

  return (
    <Tabs value={tab} onValueChange={(next) => void setTab(next as RoleTab)}>
      <DetailDrawer
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={role ? role.name : 'Role'}
        badges={
          role ? (
            <>
              <RoleTypeBadge role={role} />
              <ResourceStatusBadge status={role.resourceStatus} />
              <MemberCountBadge role={role} />
            </>
          ) : null
        }
        meta={role ? <RoleMeta role={role} /> : null}
        tabs={role ? <RoleTabsList /> : null}
        footer={
          role ? (
            <RoleDetailActions role={role} onEdit={() => setEditOpen(true)} onRequestDelete={onRequestDelete} onClone={() => setCloneOpen(true)} />
          ) : null
        }
      >
        {!open ? null : detail.isPending ? (
          <RoleDetailSkeleton />
        ) : detail.error || !role ? (
          <ErrorState
            error={detail.error ?? new GatewayError(404, 'This role does not exist or is outside your access scope.')}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <TabPanels role={role} tier={tier} />
        )}
      </DetailDrawer>
      {role ? <EditRoleDialog key={`${role.id}-${role.updatedAt}`} role={role} open={editOpen} onOpenChange={setEditOpen} /> : null}
      {role ? <CloneRoleDialog key={`clone-${role.id}`} role={role} open={cloneOpen} onOpenChange={setCloneOpen} onCloned={onCloned} /> : null}
    </Tabs>
  );
}
