'use client';

import { useId, useMemo, useState, type FormEvent } from 'react';
import { IconPencil, IconPlus, IconShieldCog, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { FilterBar, FilterSelect } from '@/shared/data/filter-bar';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import {
  useCreateRateLimitRule,
  useDeleteRateLimitRule,
  useRateLimitRules,
  useRouteCatalog,
  useTenantOptions,
  useUpdateRateLimitRule,
} from '../api/hooks';
import type { RateLimitRule, RouteCatalogEntry, TenantOption } from '../api/types';

const SCOPE_OPTIONS = [
  { value: 'all', label: 'All scopes' },
  { value: 'platform', label: 'Platform-wide' },
  { value: 'tenant', label: 'Tenant-scoped' },
];

/**
 * Which precedence rank a rule occupies, derived from its own shape rather than
 * stored: SYSTEM-owned = rank 4, tenant-owned = rank 1 unless it matches every
 * route, which is how rank 2 is expressed.
 */
function rankOf(rule: RateLimitRule): { rank: number; label: string } {
  if (rule.platform) return { rank: 4, label: 'Platform route' };
  if (rule.routeMatch === '*') return { rank: 2, label: 'Tenant' };
  return { rank: 1, label: 'Tenant × route' };
}

function RuleDialog({
  routes,
  tenants,
  isPending,
  onOpenChange,
  onSave,
}: {
  routes: readonly RouteCatalogEntry[];
  tenants: readonly TenantOption[];
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: { tenantId?: string; routeMatch: string; matchKind: 'EXACT' | 'PREFIX'; limitValue: number; windowMs: number }) => void;
}) {
  const uid = useId();
  const [tenantId, setTenantId] = useState('');
  const [routeMatch, setRouteMatch] = useState('');
  const [matchKind, setMatchKind] = useState<'EXACT' | 'PREFIX'>('EXACT');
  const [limitValue, setLimitValue] = useState('100');
  const [windowMs, setWindowMs] = useState('60000');

  const limitNum = Number(limitValue);
  const windowNum = Number(windowMs);
  const valid = routeMatch.trim().length > 0 && Number.isInteger(limitNum) && limitNum >= 1 && Number.isInteger(windowNum) && windowNum >= 1;

  // A platform rule may not govern every route — rank 5 (the tier baselines on
  // the Policy tab) is the single platform-wide knob. Say so before the gateway
  // has to.
  const platformAllRoutes = tenantId.trim().length === 0 && routeMatch.trim() === '*';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || platformAllRoutes) return;
    onSave({
      tenantId: tenantId.trim() || undefined,
      routeMatch: routeMatch.trim(),
      matchKind: routeMatch.trim() === '*' ? 'PREFIX' : matchKind,
      limitValue: limitNum,
      windowMs: windowNum,
    });
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col sm:max-w-[46rem]">
        <DialogHeader>
          <DialogTitle>New rate-limit rule</DialogTitle>
          <DialogDescription>
            Leave the tenant empty for a platform-wide route rule. A tenant rule outranks every platform rule; within a scope, an exact route beats a
            prefix.
          </DialogDescription>
        </DialogHeader>
        <form id={`${uid}-form`} onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-tenant`}>Tenant</Label>
            <select
              id={`${uid}-tenant`}
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value)}
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            >
              <option value="">Platform-wide (all tenants)</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-sm">
              A tenant-scoped rule outranks every platform rule — including one naming this exact route.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-route`}>Route</Label>
            <Input
              id={`${uid}-route`}
              list={`${uid}-routes`}
              value={routeMatch}
              onChange={(event) => setRouteMatch(event.target.value)}
              placeholder="POST:/api/v1/auth/login — or * for every route"
              className="font-mono"
              required
            />
            <datalist id={`${uid}-routes`}>
              {routes.map((route) => (
                <option key={route.routeId} value={route.routeId} />
              ))}
            </datalist>
            <p className="text-muted-foreground text-sm">
              Pick from {routes.length} gateway routes, or write a prefix such as <span className="font-mono">*:/api/v1/admin/*</span>.
            </p>
            {platformAllRoutes ? (
              <p className="text-destructive text-sm">
                A platform rule cannot target every route — set the platform-wide limit on the Policy tab’s base tiers instead.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${uid}-kind`}>Match</Label>
              <select
                id={`${uid}-kind`}
                value={matchKind}
                onChange={(event) => setMatchKind(event.target.value as 'EXACT' | 'PREFIX')}
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              >
                <option value="EXACT">Exact</option>
                <option value="PREFIX">Prefix</option>
              </select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${uid}-limit`}>Requests</Label>
              <Input id={`${uid}-limit`} value={limitValue} onChange={(event) => setLimitValue(event.target.value)} inputMode="numeric" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${uid}-window`}>Window (ms)</Label>
              <Input id={`${uid}-window`} value={windowMs} onChange={(event) => setWindowMs(event.target.value)} inputMode="numeric" required />
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={`${uid}-form`} disabled={!valid || platformAllRoutes || isPending}>
            {isPending ? <Spinner /> : null}
            Create rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Edit an existing rule's numbers. Separate from {@link RuleDialog} because the
 * scope (tenant + pattern + match kind) is the rule's IDENTITY — the unique
 * index is keyed on it — so changing it is a delete-and-recreate, not an edit.
 */
function EditRuleDialog({
  rule,
  isPending,
  onOpenChange,
  onSave,
}: {
  rule: RateLimitRule;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (body: { limitValue: number; windowMs: number }) => void;
}) {
  const uid = useId();
  const [limitValue, setLimitValue] = useState(String(rule.limitValue));
  const [windowMs, setWindowMs] = useState(String(rule.windowMs));

  const limitNum = Number(limitValue);
  const windowNum = Number(windowMs);
  const valid = Number.isInteger(limitNum) && limitNum >= 1 && Number.isInteger(windowNum) && windowNum >= 1;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onSave({ limitValue: limitNum, windowMs: windowNum });
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col sm:max-w-[36rem]">
        <DialogHeader>
          <DialogTitle>Edit rule</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{rule.routeMatch}</span> — {rule.platform ? 'platform-wide' : 'tenant-scoped'}. To change the scope or the
            pattern, delete this rule and create a new one.
          </DialogDescription>
        </DialogHeader>
        <form id={`${uid}-edit`} onSubmit={submit} className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-limit`}>Requests</Label>
            <Input id={`${uid}-limit`} value={limitValue} onChange={(event) => setLimitValue(event.target.value)} inputMode="numeric" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-window`}>Window (ms)</Label>
            <Input id={`${uid}-window`} value={windowMs} onChange={(event) => setWindowMs(event.target.value)} inputMode="numeric" required />
          </div>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={`${uid}-edit`} disabled={!valid || isPending}>
            {isPending ? <Spinner /> : null}
            Save rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RulesSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-14 w-full" />
      ))}
    </div>
  );
}

/**
 * Rules tab (TASK-785) — ranks 1, 2 and 4 of the precedence chain.
 *
 * The Policy tab still owns the kill-switch and the base tiers (rank 5); the
 * plan lane (rank 3) lives on the entitlements screen. This panel is the only
 * writer for rules.
 */
export function RateLimitRulesPanel() {
  const uid = useId();
  const [scope, setScope] = useState('all');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RateLimitRule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RateLimitRule | null>(null);

  const rulesQuery = useRateLimitRules(scope === 'all' ? {} : { scope: scope as 'platform' | 'tenant' });
  const catalogQuery = useRouteCatalog();
  const tenantsQuery = useTenantOptions();
  const createMutation = useCreateRateLimitRule();
  const updateMutation = useUpdateRateLimitRule();
  const deleteMutation = useDeleteRateLimitRule();

  const rules = useMemo(() => {
    const list = rulesQuery.data ?? [];
    // Most-significant first, so the list reads in the same order the resolver
    // evaluates: rank 1 → 2 → 4, then most specific pattern within a rank.
    return [...list].sort((a, b) => rankOf(a).rank - rankOf(b).rank || b.routeMatch.length - a.routeMatch.length);
  }, [rulesQuery.data]);

  if (rulesQuery.isPending) return <RulesSkeleton />;
  if (rulesQuery.error) return <ErrorState error={rulesQuery.error} onRetry={() => void rulesQuery.refetch()} />;

  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <FilterSelect id={`${uid}-scope`} label="Scope" value={scope} onChange={setScope} options={SCOPE_OPTIONS} />
        <Button type="button" onClick={() => setCreating(true)} className="ms-auto">
          <IconPlus aria-hidden />
          New rule
        </Button>
      </FilterBar>

      {rules.length === 0 ? (
        <EmptyState
          icon={IconShieldCog}
          title="No rate-limit rules"
          description="Every route currently resolves from its plan, its @Throttle default, or the base tier. Add a rule to override one tenant, one route, or both."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rules.map((rule) => {
            const rank = rankOf(rule);
            // Two rules can name the SAME route in different scopes (one
            // platform, one tenant), so the scope has to be part of every
            // accessible name — otherwise the two rows' buttons are
            // indistinguishable to a screen reader.
            const scopeLabel = rule.platform ? 'platform rule' : `tenant rule (${rule.tenantId})`;
            return (
              <li key={rule.id} className="bg-card flex flex-wrap items-center gap-3 rounded-md border p-3">
                <Badge variant={rule.platform ? 'outline' : 'secondary'}>
                  {rank.rank}. {rank.label}
                </Badge>
                <span className="font-mono text-sm">{rule.routeMatch}</span>
                <Badge variant="outline" className="text-2xs font-mono">
                  {rule.matchKind}
                </Badge>
                {!rule.platform ? <span className="text-muted-foreground truncate font-mono text-xs">{rule.tenantId}</span> : null}
                <span className="text-muted-foreground ms-auto text-sm">
                  {rule.limitValue} / {Math.round(rule.windowMs / 1000)}s
                </span>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={rule.active}
                    aria-label={rule.active ? `Exempt ${scopeLabel} ${rule.routeMatch}` : `Enforce ${scopeLabel} ${rule.routeMatch}`}
                    disabled={updateMutation.isPending}
                    onCheckedChange={(active) =>
                      updateMutation.mutate(
                        { id: rule.id, body: { active } },
                        {
                          onSuccess: () => toast.success(active ? 'Rule enforcing' : 'Rule now exempts this scope'),
                          onError: (error) => toast.error(error.message),
                        },
                      )
                    }
                  />
                  <span className="text-muted-foreground">{rule.active ? 'Enforced' : 'Exempt'}</span>
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${scopeLabel} ${rule.routeMatch}`}
                  onClick={() => setEditing(rule)}
                >
                  <IconPencil aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${scopeLabel} ${rule.routeMatch}`}
                  onClick={() => setDeleteTarget(rule)}
                >
                  <IconTrash aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {creating ? (
        <RuleDialog
          routes={catalogQuery.data ?? []}
          tenants={tenantsQuery.data ?? []}
          isPending={createMutation.isPending}
          onOpenChange={(open) => {
            if (!open) setCreating(false);
          }}
          onSave={(input) =>
            createMutation.mutate(input, {
              onSuccess: () => {
                toast.success('Rule created');
                setCreating(false);
              },
              onError: (error) => toast.error(error.message),
            })
          }
        />
      ) : null}

      {editing ? (
        <EditRuleDialog
          key={editing.id}
          rule={editing}
          isPending={updateMutation.isPending}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSave={(body) =>
            updateMutation.mutate(
              { id: editing.id, body },
              {
                onSuccess: () => {
                  toast.success('Rule updated');
                  setEditing(null);
                },
                onError: (error) => toast.error(error.message),
              },
            )
          }
        />
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete this rule?"
        description={
          <>
            <span className="font-mono">{deleteTarget?.routeMatch}</span> falls back to the next level of the precedence chain immediately.
          </>
        }
        confirmLabel="Delete rule"
        destructive
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteMutation.mutate(deleteTarget.id, {
            onSuccess: () => {
              toast.success('Rule deleted');
              setDeleteTarget(null);
            },
            onError: (error) => toast.error(error.message),
          });
        }}
      />
    </div>
  );
}
