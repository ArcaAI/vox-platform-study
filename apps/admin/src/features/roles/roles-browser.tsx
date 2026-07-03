/**
 * TASK-395 P1-3 (§5.1 · `24`) — Roles master-detail browser.
 *
 * Left: an indented **inheritance tree** (parent → child via `parentRoleId`) with
 * monochrome shield tiles + a 🔒 on system roles and a per-role policy count.
 * Right: the selected role's detail — System badge, inheritance (root / inherits /
 * extended-by), attached + inherited policies, and a live **effective-abilities
 * preview** computed from the union of CASL rules (design-flagged TARGET).
 *
 * Replaces the flat roster table; the existing New/Edit/Delete + Manage-policies
 * affordances (system roles stay protected) are preserved via callbacks.
 */
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Spinner } from '@arcaai/ui/spinner';
import { StatusBadge } from '@arcaai/ui/components/shared';
import type { Policy, Role } from '@arcaai/vox';
import { CornerDownRight, KeyRound, Lock, Pencil, Shield, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { buildRoleTree, childRoles, collectPolicyRefs, effectiveAbilities, flattenRoleTree, parentRole } from './abilities';
import { rolePolicies, type RoleWithPolicies } from './types';

/** Depth → left padding (indentation), clamped so deep trees stay legible. */
const DEPTH_PADDING = ['pl-3', 'pl-8', 'pl-12', 'pl-16', 'pl-20'] as const;

function displayName(role: Role): string {
  const external = (role as RoleWithPolicies & { externalName?: unknown }).externalName;
  return (typeof external === 'string' && external.trim()) || role.name;
}

function isSystemRole(role: Role): boolean {
  return (role as RoleWithPolicies).isSystemRole === true;
}

interface RolesBrowserProps {
  roles: Role[];
  policies: Policy[];
  isLoading?: boolean;
  onEdit: (role: RoleWithPolicies) => void;
  onManagePolicies: (role: RoleWithPolicies) => void;
  onDelete: (role: RoleWithPolicies) => void;
}

export function RolesBrowser({ roles, policies, isLoading, onEdit, onManagePolicies, onDelete }: RolesBrowserProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = useMemo(() => flattenRoleTree(buildRoleTree(roles)), [roles]);

  // Default / repair the selection as the roster loads.
  useEffect(() => {
    if (rows.length === 0) return;
    setSelectedId((prev) => (prev && rows.some((r) => r.role.id === prev) ? prev : rows[0].role.id));
  }, [rows]);

  const selected = (roles.find((r) => r.id === selectedId) as RoleWithPolicies | undefined) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Roles · inheritance</h3>
          <span className="tabular-nums text-xs text-muted-foreground">{roles.length}</span>
        </div>
        <div className="max-h-120 overflow-auto py-1">
          {isLoading && rows.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
              <Spinner className="mr-2 size-4" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">No roles yet.</div>
          ) : (
            rows.map(({ role, depth }) => (
              <RoleTile
                key={role.id}
                role={role}
                depth={depth}
                selected={role.id === selectedId}
                policyCount={rolePolicies(role).length}
                onSelect={() => setSelectedId(role.id)}
              />
            ))
          )}
        </div>
      </div>

      <div className="rounded-lg border">
        {selected ? (
          <RoleDetail role={selected} roles={roles} policies={policies} onEdit={onEdit} onManagePolicies={onManagePolicies} onDelete={onDelete} />
        ) : (
          <div className="flex h-full min-h-48 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Select a role to inspect its policies and effective abilities.
          </div>
        )}
      </div>
    </div>
  );
}

function RoleTile({
  role,
  depth,
  selected,
  policyCount,
  onSelect,
}: {
  role: RoleWithPolicies;
  depth: number;
  selected: boolean;
  policyCount: number;
  onSelect: () => void;
}) {
  const system = isSystemRole(role);
  const Icon = system ? ShieldCheck : Shield;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2 border-l-2 py-2 pr-3 text-left text-sm transition-colors',
        DEPTH_PADDING[Math.min(depth, DEPTH_PADDING.length - 1)],
        selected ? 'border-l-primary bg-accent' : 'border-l-transparent hover:bg-muted',
      )}
    >
      {depth > 0 ? <CornerDownRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden /> : null}
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium">{displayName(role)}</span>
          {system ? <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="System role" /> : null}
        </span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">{role.name}</span>
      </span>
      <Badge variant="secondary" className="tabular-nums" title={`${policyCount} attached ${policyCount === 1 ? 'policy' : 'policies'}`}>
        {policyCount}
      </Badge>
    </button>
  );
}

function RoleDetail({
  role,
  roles,
  policies,
  onEdit,
  onManagePolicies,
  onDelete,
}: {
  role: RoleWithPolicies;
  roles: Role[];
  policies: Policy[];
  onEdit: (role: RoleWithPolicies) => void;
  onManagePolicies: (role: RoleWithPolicies) => void;
  onDelete: (role: RoleWithPolicies) => void;
}) {
  const system = isSystemRole(role);
  const parent = parentRole(role, roles);
  const kids = childRoles(role, roles);
  const refs = useMemo(() => collectPolicyRefs(role, roles), [role, roles]);
  const abilities = useMemo(() => effectiveAbilities(role, roles, policies), [role, roles, policies]);

  return (
    <div className="space-y-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">{displayName(role)}</h3>
            {system ? <StatusBadge label="System" colorRole="hope" icon={<ShieldCheck />} /> : null}
          </div>
          <p className="font-mono text-xs text-muted-foreground">{role.name}</p>
          {role.description ? <p className="mt-1 text-sm text-muted-foreground">{role.description}</p> : null}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="outline" size="sm" onClick={() => onManagePolicies(role)} aria-label={`Manage policies for ${role.name}`}>
            <KeyRound className="size-4" />
            Policies
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => onEdit(role)} disabled={system} aria-label={`Edit ${role.name}`}>
            <Pencil className="size-4" />
          </Button>
          {/* TASK-409 — role deletion now goes through the break-glass
                        dialog (type-the-name + password), which IS the confirmation;
                        the parent route opens it from onDelete. */}
          <Button variant="ghost" size="icon" className="size-8" disabled={system} onClick={() => onDelete(role)} aria-label={`Delete ${role.name}`}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </header>

      <section className="rounded-md border bg-muted/20 p-3 text-sm">
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Inheritance</div>
        <p>
          {parent ? (
            <>
              Inherits from <span className="font-medium">{displayName(parent)}</span>
            </>
          ) : (
            'Root role'
          )}
        </p>
        {kids.length > 0 ? <p className="mt-0.5 text-muted-foreground">Extended by {kids.map((c) => displayName(c)).join(', ')}</p> : null}
      </section>

      <section>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Policies <span className="tabular-nums">({refs.length})</span>
        </div>
        {refs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No policies attached.</p>
        ) : (
          <ul className="space-y-1">
            {refs.map((ref) => (
              <li key={ref.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5">
                <span className="truncate font-mono text-xs">{ref.name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {ref.inheritedFrom ? (
                    <Badge variant="outline" className="text-[10px]">
                      inherited · {ref.inheritedFrom}
                    </Badge>
                  ) : null}
                  {typeof ref.priority === 'number' ? <span className="tabular-nums text-[11px] text-muted-foreground">p{ref.priority}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Effective abilities <span className="font-normal normal-case text-muted-foreground">· attached + inherited</span>
        </div>
        {abilities.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {refs.length > 0 ? 'Resolving policy rules…' : 'No abilities — attach a policy to grant access.'}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {abilities.map((ability) => (
              <li key={ability.subject} className="flex flex-col gap-1.5 rounded-md border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="font-mono text-xs" title={ability.sources.join(', ')}>
                  {ability.subject}
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  {ability.manage ? (
                    <Badge className="text-[10px]">manage · all</Badge>
                  ) : (
                    ability.actions.map((action) => (
                      <Badge key={action} variant="secondary" className="text-[10px]">
                        {action}
                      </Badge>
                    ))
                  )}
                  {ability.conditional ? (
                    <Badge variant="outline" className="border-warning/40 text-[10px] text-warning">
                      scoped
                    </Badge>
                  ) : null}
                  {ability.denied.length > 0 ? (
                    <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive">
                      cannot: {ability.denied.join(', ')}
                    </Badge>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Simulated client-side from CASL policy rules; the API remains the enforcement source (design TARGET).
        </p>
      </section>
    </div>
  );
}
