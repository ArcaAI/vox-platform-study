import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import type { CapabilityUsageRow, EntitlementCapabilities, TrialInfo } from '@arcaai/vox';
import { CircleCheck, CircleX, Clock, ShieldCheck, ShieldOff, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TenantPlanBadge, type TenantPlan } from '@/features/tenants/tenant-plan';
import { capabilityLabel, trialCountdownText, trialTone, usageColorRole, usageLabel, usagePercent, usageTone } from './entitlements-format';

/** Fill color for the usage bar, keyed off the server-computed row flags. */
const FILL_CLASS: Record<'destructive' | 'warning' | 'success' | 'neutral', string> = {
  destructive: 'bg-destructive',
  warning: 'bg-warning',
  success: 'bg-success',
  neutral: 'bg-muted-foreground/30',
};

/** One capability row: label, used / limit, and a tone-colored fill bar. */
export function UsageBar({ row }: { row: CapabilityUsageRow }) {
  const pct = usagePercent(row);
  const tone = usageTone(row);
  const role = usageColorRole(row);
  return (
    <div className="flex flex-col gap-1.5" data-testid={`usage-${row.key}`} data-tone={tone}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium">{capabilityLabel(row.key)}</span>
        <span className="flex items-center gap-2 text-muted-foreground">
          <span className="font-mono text-xs">{usageLabel(row)}</span>
          {tone === 'exceeded' ? <StatusBadge label="Limit reached" colorRole="destructive" /> : null}
          {tone === 'near' ? <StatusBadge label="Near limit" colorRole="warning" /> : null}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={pct ?? undefined}
        aria-label={capabilityLabel(row.key)}
      >
        {pct !== null ? <div className={cn('h-full rounded-full transition-all', FILL_CLASS[role])} style={{ width: `${pct}%` }} /> : null}
      </div>
    </div>
  );
}

/** Trial countdown / expiry banner (Q4). Renders nothing off-trial. */
export function TrialBanner({ trial }: { trial: TrialInfo }) {
  const tone = trialTone(trial);
  if (tone === 'none') return null;
  const destructive = tone === 'expired';
  return (
    <Alert variant={destructive ? 'destructive' : 'default'} className={cn(!destructive && tone === 'urgent' && 'border-warning/40 text-warning')}>
      {destructive ? <TriangleAlert className="size-4" /> : <Clock className="size-4" />}
      <AlertTitle>{destructive ? 'Trial expired' : 'Trial in progress'}</AlertTitle>
      <AlertDescription>{trialCountdownText(trial)}</AlertDescription>
    </Alert>
  );
}

function FeatureBadge({ label, on }: { label: string; on: boolean }) {
  return <StatusBadge label={label} colorRole={on ? 'success' : 'neutral'} icon={on ? <CircleCheck /> : <CircleX />} />;
}

export function CapabilitySnapshotSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-6 w-64" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-52 w-full rounded-lg" />
        <Skeleton className="h-52 w-full rounded-lg" />
      </div>
    </div>
  );
}

/**
 * Read-only capability/usage snapshot for a tenant — reused by the super-admin
 * tenant view and the tenant self-view (`/entitlements/me`). Shows plan +
 * enforcement + tiers, the trial banner, quantity + monthly-meter usage bars,
 * and resolved feature toggles.
 */
export function CapabilitySnapshot({ snapshot }: { snapshot: EntitlementCapabilities }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <TenantPlanBadge plan={(snapshot.plan ?? null) as TenantPlan | null} />
        {!snapshot.gated ? <StatusBadge label="Ungated (legacy)" colorRole="neutral" /> : null}
        <StatusBadge
          label={snapshot.enforcementEnabled ? 'Enforcement ON' : 'Enforcement OFF'}
          colorRole={snapshot.enforcementEnabled ? 'success' : 'neutral'}
          icon={snapshot.enforcementEnabled ? <ShieldCheck /> : <ShieldOff />}
        />
        <StatusBadge label={`Models: ${snapshot.modelTier}`} colorRole="info" />
        <StatusBadge
          label={`Rate: ${snapshot.rateLimitTier}${snapshot.rateLimitPerMinute ? ` (${snapshot.rateLimitPerMinute}/min)` : ''}`}
          colorRole="info"
        />
      </div>

      <TrialBanner trial={snapshot.trial} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Resource limits</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {snapshot.quantities.length === 0 ? (
              <p className="text-sm text-muted-foreground">No quantity capabilities.</p>
            ) : (
              snapshot.quantities.map((row) => <UsageBar key={row.key} row={row} />)
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Monthly usage</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {snapshot.meters.length === 0 ? (
              <p className="text-sm text-muted-foreground">No metered capabilities.</p>
            ) : (
              snapshot.meters.map((row) => <UsageBar key={row.key} row={row} />)
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Features</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <FeatureBadge label="DNA reports" on={snapshot.features.dnaReports} />
          <FeatureBadge label="Voice enrollment" on={snapshot.features.voiceEnrollment} />
          <FeatureBadge label="Monitoring access" on={snapshot.features.monitoringAccess} />
        </CardContent>
      </Card>
    </div>
  );
}
