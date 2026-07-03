import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import {
  useEntitlements,
  useTenants,
  type EntitlementCapabilities,
  type PlanEntitlement,
  type TenantEntitlementOverride,
  type UpdatePlanEntitlementInput,
  type UpsertTenantOverrideInput,
} from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Pencil, TrendingDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { ConfirmDelete } from '@/features/common/confirm-delete';
import { reduceOccConflict } from '@/features/common/occ';
import { CapabilitySnapshot, CapabilitySnapshotSkeleton } from '@/features/entitlements/capability-snapshot';
import { formatCapabilityValue, quotaErrorMessage } from '@/features/entitlements/entitlements-format';
import { PlanEditDialog } from '@/features/entitlements/plan-edit-dialog';
import { TenantOverrideDialog } from '@/features/entitlements/tenant-override-dialog';
import { TENANT_PLAN_VALUES, TenantPlanBadge, planLabel, type TenantPlan } from '@/features/tenants/tenant-plan';
import { isSuperAdmin } from '@/features/tenants/permissions';
import { useAuthStore } from '@/store/auth-store';

export const Route = createFileRoute('/_authenticated/entitlements')({
  staticData: { crumb: [{ label: 'Settings', to: null }, { label: 'Entitlements' }] },
  component: EntitlementsPage,
});

// ── Kill-switch (Q9) ─────────────────────────────────────────────────────────

function KillSwitchCard() {
  const { enabled, getEnabled, setEnabled } = useEntitlements();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getEnabled().catch(() => undefined);
  }, [getEnabled]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      await setEnabled(next);
      toast.success(next ? 'Enforcement enabled' : 'Enforcement disabled');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update kill-switch');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Enforcement kill-switch</CardTitle>
        <CardDescription>
          When OFF (the default), limits are computed and displayed but never block. When ON, over-limit create/usage actions are blocked and
          downgrades soft-disable overflow resources.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between rounded-md border px-4 py-3">
          <div className="flex flex-col">
            <span className="text-sm font-medium">Global enforcement</span>
            <span className="text-xs text-muted-foreground">Applies to every gated tenant (null-plan tenants stay ungated).</span>
          </div>
          {enabled === undefined ? (
            <Skeleton className="h-6 w-11 rounded-full" />
          ) : (
            <Switch checked={enabled} onCheckedChange={(v) => void toggle(v)} disabled={busy} aria-label="Toggle global enforcement" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Plan matrix (Q1) ──────────────────────────────────────────────────────────

function PlanMatrixCard() {
  const { plans, isLoading, error, listPlans, getPlan, updatePlan } = useEntitlements();
  const [editing, setEditing] = useState<PlanEntitlement | null>(null);

  useEffect(() => {
    void listPlans().catch(() => undefined);
  }, [listPlans]);

  const openEdit = async (plan: PlanEntitlement) => {
    try {
      setEditing(await getPlan(plan.plan));
    } catch {
      setEditing(plan);
    }
  };

  const onSave = async (planKey: string, input: UpdatePlanEntitlementInput) => {
    try {
      await updatePlan(planKey, input);
      toast.success(`${planLabel(planKey as TenantPlan)} plan updated`);
      setEditing(null);
    } catch (err) {
      const occ = reduceOccConflict(err);
      if (occ.conflict) {
        toast.error(occ.message);
        try {
          setEditing(await getPlan(planKey));
        } catch {
          setEditing(null);
        }
        return;
      }
      toast.error(err instanceof Error ? err.message : 'Failed to update plan');
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Plan matrix</CardTitle>
        <CardDescription>Per-plan default limits. Edits apply to every tenant on the plan unless a per-tenant override is set.</CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>Couldn’t load the plan matrix</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : null}
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead>
                <TableHead>Users</TableHead>
                <TableHead>Depts</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>Models</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead className="w-16 text-right">Edit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && plans.length === 0 ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : plans.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    No plan rows.
                  </TableCell>
                </TableRow>
              ) : (
                plans.map((p) => (
                  <TableRow key={p.plan}>
                    <TableCell>
                      <TenantPlanBadge plan={p.plan as TenantPlan} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{formatCapabilityValue('users', p.maxUsers)}</TableCell>
                    <TableCell className="font-mono text-xs">{formatCapabilityValue('departments', p.maxDepartments)}</TableCell>
                    <TableCell className="font-mono text-xs">{formatCapabilityValue('storageBytes', p.storageQuotaBytes)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.modelTier}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.rateLimitTier}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="size-8" onClick={() => void openEdit(p)} aria-label={`Edit ${p.plan} plan`}>
                        <Pencil className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      <PlanEditDialog plan={editing} open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} onSave={onSave} />
    </Card>
  );
}

// ── Per-tenant tools (snapshot + override + downgrade, Q1/Q7/Q10) ─────────────

function TenantToolsCard() {
  const { getTenantSnapshot, getOverride, upsertOverride, clearOverride, triggerDowngrade, runTrialExpiry } = useEntitlements();
  const { tenants, list: listTenants } = useTenants();
  const [tenantId, setTenantId] = useState('');
  const [snapshot, setSnapshot] = useState<EntitlementCapabilities | null>(null);
  const [loadingSnap, setLoadingSnap] = useState(false);
  const [override, setOverride] = useState<TenantEntitlementOverride | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [downgradePlan, setDowngradePlan] = useState<TenantPlan>('STARTER');

  useEffect(() => {
    void listTenants().catch(() => undefined);
  }, [listTenants]);

  const loadSnapshot = async (id: string) => {
    if (!id) return;
    setLoadingSnap(true);
    setSnapshot(null);
    try {
      setSnapshot(await getTenantSnapshot(id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load tenant snapshot');
    } finally {
      setLoadingSnap(false);
    }
  };

  const openOverride = async () => {
    try {
      setOverride(await getOverride(tenantId));
    } catch {
      setOverride(null);
    }
    setOverrideOpen(true);
  };

  const onSaveOverride = async (id: string, input: UpsertTenantOverrideInput) => {
    try {
      await upsertOverride(id, input);
      toast.success('Override saved');
      setOverrideOpen(false);
      await loadSnapshot(id);
    } catch (err) {
      const occ = reduceOccConflict(err);
      if (occ.conflict) {
        toast.error(occ.message);
        try {
          setOverride(await getOverride(id));
        } catch {
          /* keep dialog open */
        }
        return;
      }
      toast.error(quotaErrorMessage(err) ?? (err instanceof Error ? err.message : 'Failed to save override'));
    }
  };

  const onClearOverride = async (id: string) => {
    try {
      await clearOverride(id);
      toast.success('Override cleared — tenant reverts to the plan default');
      setOverrideOpen(false);
      await loadSnapshot(id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to clear override');
    }
  };

  const onDowngrade = async () => {
    try {
      const report = await triggerDowngrade(tenantId, downgradePlan);
      toast.success(
        report.totalDisabled > 0
          ? `Downgraded to ${planLabel(downgradePlan)} — ${report.totalDisabled} resource(s) soft-disabled`
          : `Downgraded to ${planLabel(downgradePlan)} (no resources disabled)`,
      );
      await loadSnapshot(tenantId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to downgrade');
    }
  };

  const onRunTrialExpiry = async () => {
    try {
      const report = await runTrialExpiry();
      toast.success(`Trial sweep complete — examined ${report.examined}, downgraded ${report.downgraded}`);
      if (tenantId) await loadSnapshot(tenantId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run trial-expiry sweep');
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Tenant tools</CardTitle>
        <CardDescription>
          Inspect any tenant’s capabilities, set a per-tenant override, downgrade a plan, or run the trial-expiry sweep.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-64 flex-col gap-1.5">
            <Label htmlFor="tenant-select">Tenant</Label>
            <Select
              value={tenantId}
              onValueChange={(v) => {
                setTenantId(v);
                void loadSnapshot(v);
              }}
            >
              <SelectTrigger id="tenant-select" className="w-72">
                <SelectValue placeholder="Select a tenant…" />
              </SelectTrigger>
              <SelectContent>
                {tenants.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} {t.plan ? `· ${planLabel(t.plan as TenantPlan)}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ConfirmDelete
            trigger={
              <Button variant="outline" disabled={!tenantId}>
                Run trial-expiry sweep
              </Button>
            }
            title="Run the trial-expiry sweep?"
            description="Downgrades every expired TRIAL tenant to Starter (plan-only; no resources are disabled). Safe to run repeatedly."
            confirmLabel="Run sweep"
            onConfirm={onRunTrialExpiry}
          />
        </div>

        {tenantId ? (
          loadingSnap ? (
            <CapabilitySnapshotSkeleton />
          ) : snapshot ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-3">
                <Button variant="outline" onClick={() => void openOverride()}>
                  <Pencil className="size-4" />
                  Edit override
                </Button>
                <div className="flex items-end gap-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="downgrade-plan">Downgrade to</Label>
                    <Select value={downgradePlan} onValueChange={(v) => setDowngradePlan(v as TenantPlan)}>
                      <SelectTrigger id="downgrade-plan" className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TENANT_PLAN_VALUES.map((p) => (
                          <SelectItem key={p} value={p}>
                            {planLabel(p)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <ConfirmDelete
                    trigger={
                      <Button variant="outline" className="text-destructive">
                        <TrendingDown className="size-4" />
                        Downgrade
                      </Button>
                    }
                    title={`Downgrade to ${planLabel(downgradePlan)}?`}
                    description="The plan changes immediately. When enforcement is ON, the newest overflow resources are soft-disabled (reversible — never deleted); existing resources within the new limit are grandfathered."
                    confirmLabel="Apply downgrade"
                    onConfirm={onDowngrade}
                  />
                </div>
              </div>
              <CapabilitySnapshot snapshot={snapshot} />
            </div>
          ) : null
        ) : (
          <p className="text-sm text-muted-foreground">Select a tenant to inspect its capabilities and usage.</p>
        )}
      </CardContent>
      <TenantOverrideDialog
        tenantId={tenantId}
        override={override}
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        onSave={onSaveOverride}
        onClear={onClearOverride}
      />
    </Card>
  );
}

// ── Tenant self-view (`/entitlements/me`) ─────────────────────────────────────

function SelfView() {
  const { me } = useEntitlements();
  const [snapshot, setSnapshot] = useState<EntitlementCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    me()
      .then(setSnapshot)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load entitlements'));
  }, [me]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>Couldn’t load your entitlements</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!snapshot) return <CapabilitySnapshotSkeleton />;
  return <CapabilitySnapshot snapshot={snapshot} />;
}

function EntitlementsPage() {
  const roles = useAuthStore((s) => s.user?.roles);
  const superAdmin = isSuperAdmin(roles);

  return (
    <div>
      <PageHeader
        title="Entitlements"
        description={superAdmin ? 'Plan limits, per-tenant overrides, usage and lifecycle actions.' : 'Your plan limits and current usage.'}
      />
      {superAdmin ? (
        <div className="flex flex-col gap-6">
          <KillSwitchCard />
          <PlanMatrixCard />
          <TenantToolsCard />
        </div>
      ) : (
        <SelfView />
      )}
    </div>
  );
}
