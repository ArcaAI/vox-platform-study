'use client';

import { toast } from 'sonner';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useDnaSettings, useUpdateDnaSettings } from '../api';

/**
 * Frame 53 — the per-doctor DNA on/off switch over GET/PUT /settings.
 * The switch binds to `doctorToggle` (null = implicit
 * opt-in) and locks when the tenant cascade disabled DNA (`tenantEnabled`
 * false — a doctor cannot opt in past the tenant) or while the 403 gate is
 * up. OCC is optional on this route: the PUT carries `expectedVersion` from
 * the GET (omitted while the row does not exist yet, version 0); drift lands
 * on the 412 conflict notice.
 */
export function DnaSettingsCard({ settings, gated, onGate }: { settings: ReturnType<typeof useDnaSettings>; gated: boolean; onGate: () => void }) {
  const update = useUpdateDnaSettings();
  const data = settings.data;

  function handleToggle(enabled: boolean) {
    if (!data) return;
    // The client derives the OCC precondition (If-Match + body
    // expectedVersion once a DOCTOR row exists) from currentVersion.
    update.mutate(
      { body: { enabled }, currentVersion: data.version },
      {
        onSuccess: () => toast.success('DNA settings updated'),
        onError: (error) => {
          if (error instanceof GatewayError) {
            // Designed gate state — the panel takes over, no toast.
            if (error.status === 403) {
              onGate();
              return;
            }
            // OCC drift renders inline below.
            if (error.isVersionConflict || error.isMissingPrecondition) return;
          }
          toast.error(error instanceof GatewayError ? error.message : 'Could not update the DNA settings.');
        },
      },
    );
  }

  let body;
  if (settings.isPending) {
    body = (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  } else if (settings.isError) {
    body = <ErrorState title={'Couldn\u2019t load the DNA settings'} error={settings.error} onRetry={() => void settings.refetch()} />;
  } else {
    // Read through the narrowed success variant (`data` above is captured
    // before the isPending/isError checks, so TS keeps it optional).
    const current = settings.data;
    body = (
      <div className="flex flex-col gap-3">
        <OccConflictAlert
          error={update.error}
          onReload={() => {
            update.reset();
            void settings.refetch();
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="playground-dna-toggle">Use my DNA style</Label>
          <Switch
            id="playground-dna-toggle"
            checked={current.doctorToggle ?? true}
            onCheckedChange={handleToggle}
            disabled={gated || !current.tenantEnabled || update.isPending}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label={`Tenant ${current.tenantEnabled ? 'ON' : 'OFF'}`} colorRole={current.tenantEnabled ? 'success' : 'neutral'} />
          <StatusBadge label={`Effective ${current.effective ? 'ON' : 'OFF'}`} colorRole={current.effective ? 'success' : 'neutral'} />
        </div>
        {!current.tenantEnabled ? (
          <p className="text-muted-foreground text-xs">The tenant cascade has DNA disabled — the doctor toggle is locked until it is re-enabled.</p>
        ) : gated ? (
          <p className="text-muted-foreground text-xs">Requires acting as a doctor — see the impersonation gate.</p>
        ) : current.doctorToggle === null ? (
          <p className="text-muted-foreground text-xs">No explicit override yet — the implicit opt-in applies.</p>
        ) : null}
      </div>
    );
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-semibold">DNA settings</h2>
        <CardAction>
          <span aria-hidden className="text-muted-foreground font-mono text-xs">
            GET/PUT /settings
          </span>
        </CardAction>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
