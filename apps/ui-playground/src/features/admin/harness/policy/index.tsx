import { AlertCircle, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, Separator, Skeleton } from '@arcaai/ui';
import { useAuthStore } from '@/store/auth-store';
import { AdminApiError } from '../../api/admin-client';
import {
  useGlobalHarnessPolicy,
  useHarnessPolicy,
  useUpdateGlobalHarnessPolicy,
  useUpdateHarnessPolicy,
  type UpdateHarnessPolicyRequest,
} from '../api/harness';
import { PolicyEditor } from './policy-editor';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AdminApiError) {
    if (error.status === 412) return 'This policy changed since you loaded it. Refresh and re-apply your edits.';
    if (error.status === 428) return 'A version precondition is required. Refresh and try again.';
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}

function EditorSkeleton() {
  return (
    <div className="space-y-4 rounded-md border p-4" data-testid="policy-skeleton">
      <Skeleton className="h-6 w-48" />
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <Skeleton className="h-24 w-full" />
      <div className="flex justify-end">
        <Skeleton className="h-9 w-28" />
      </div>
    </div>
  );
}

export default function HarnessPolicyPage() {
  const tenantId = useAuthStore((s) => s.tenantId);
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());

  const tenantPolicy = useHarnessPolicy(tenantId || undefined);
  const updateTenant = useUpdateHarnessPolicy();

  // Only platform (global-admin) operators may read/edit the global default; gate
  // the query so a tenant admin never triggers the 403 route.
  const globalPolicy = useGlobalHarnessPolicy({ enabled: isGlobalScope });
  const updateGlobal = useUpdateGlobalHarnessPolicy();

  const submitTenant = (body: UpdateHarnessPolicyRequest, version: number) => {
    updateTenant.mutate(
      { body, version, tenantId: tenantId || undefined },
      {
        onSuccess: () => toast.success('Harness policy updated'),
        onError: (e) => toast.error(errorMessage(e, 'Failed to update policy')),
      },
    );
  };

  const submitGlobal = (body: UpdateHarnessPolicyRequest, version: number) => {
    updateGlobal.mutate(
      { body, version },
      {
        onSuccess: () => toast.success('Platform default policy updated'),
        onError: (e) => toast.error(errorMessage(e, 'Failed to update global default')),
      },
    );
  };

  return (
    <section aria-label="Harness policy">
      <div className="mb-4">
        <h2 className="text-xl font-semibold tracking-tight">Policy</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Sensor thresholds, safety toggles, models, and gate timers the clinical loop reads live. Every edit is optimistic-concurrency guarded and
          WORM-audited.
        </p>
      </div>

      {tenantPolicy.isLoading ? (
        <EditorSkeleton />
      ) : tenantPolicy.isError ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <AlertCircle className="text-destructive size-6" aria-hidden />
            <p className="text-muted-foreground text-sm">{errorMessage(tenantPolicy.error, 'Failed to load the harness policy.')}</p>
          </CardContent>
        </Card>
      ) : tenantPolicy.data ? (
        <PolicyEditor
          policy={tenantPolicy.data}
          isSaving={updateTenant.isPending}
          onSubmit={submitTenant}
          title="Tenant policy"
          description="The effective policy for the selected tenant (tenant override → system default → code default). Saving creates a tenant override on first edit."
          scopeBadge="tenant"
          idPrefix="tenant"
        />
      ) : null}

      {/* Platform-only: GLOBAL-DEFAULT editor (global-admin / platform scope). */}
      {isGlobalScope && (
        <div className="mt-8" data-testid="global-policy-section">
          <Separator className="mb-6" />
          <div className="mb-3 flex items-center gap-2">
            <ShieldCheck className="text-muted-foreground size-4" aria-hidden />
            <h3 className="text-base font-semibold">Platform default</h3>
          </div>
          <p className="text-muted-foreground mb-4 text-sm">
            The platform-wide GLOBAL-DEFAULT every tenant inherits until it sets its own override. Editing this affects all tenants without a tenant
            policy.
          </p>
          {globalPolicy.isLoading ? (
            <EditorSkeleton />
          ) : globalPolicy.isError ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <AlertCircle className="text-destructive size-6" aria-hidden />
                <p className="text-muted-foreground text-sm">{errorMessage(globalPolicy.error, 'Failed to load the global default policy.')}</p>
              </CardContent>
            </Card>
          ) : globalPolicy.data ? (
            <PolicyEditor
              policy={globalPolicy.data}
              isSaving={updateGlobal.isPending}
              onSubmit={submitGlobal}
              title="Platform default policy"
              description="The SYSTEM-tenant GLOBAL-DEFAULT row. Tenants without an override inherit these values."
              scopeBadge="global default"
              idPrefix="global"
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
