import { useCallback } from 'react';
import { toast } from 'sonner';

import { Badge } from '@arcaai/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Label } from '@arcaai/ui/label';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';
import { Dna } from 'lucide-react';

import { useDnaSettings, useUpdateDnaSettings } from '../api/dna-writing-styles';

/**
 * TASK-356 Phase 6 (S3/S7) — per-doctor DNA writing-style on/off switch.
 *
 * Binds to `GET/PUT /dna-writing-styles/settings`. The switch reflects the
 * doctor's effective opt-in (`doctorToggle ?? true`). When the TENANT cascade
 * disables DNA (`tenantEnabled === false`) the switch is disabled and the reason
 * is explained — a doctor cannot opt in when their tenant turned DNA off
 * (effective = tenant AND doctor).
 */
export function DnaSettingsCard() {
  const { data: settings, isLoading } = useDnaSettings();
  const updateMutation = useUpdateDnaSettings();

  const handleToggle = useCallback(
    (next: boolean) => {
      updateMutation.mutate(
        { enabled: next, expectedVersion: settings?.version },
        {
          onSuccess: (data) => {
            toast.success(data.effective ? 'DNA writing style enabled' : 'DNA writing style disabled');
          },
          onError: (err) => toast.error(`Failed to update DNA setting: ${err.message}`),
        },
      );
    },
    [updateMutation, settings?.version],
  );

  if (isLoading || !settings) {
    return (
      <Card data-doc="dna-settings">
        <CardHeader className="pb-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  const checked = settings.doctorToggle ?? true;
  const tenantOff = !settings.tenantEnabled;

  return (
    <Card data-doc="dna-settings">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Dna className="size-4" aria-hidden="true" />
          DNA Writing Style
          <Badge variant={settings.effective ? 'default' : 'secondary'}>{settings.effective ? 'Active' : 'Off'}</Badge>
        </CardTitle>
        <CardDescription>
          Personalize generated documentation to match your writing style. The system learns from your edits to AI drafts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="dna-enabled-switch" className="text-sm font-medium">
              Apply my DNA writing style
            </Label>
            <p className="text-muted-foreground text-xs">
              {tenantOff
                ? 'Your organization has turned DNA writing style off. You cannot opt in until it is re-enabled.'
                : checked
                  ? 'Your documentation is personalized and your edits are learned from.'
                  : 'You have opted out — documentation is not personalized and your edits are not learned from.'}
            </p>
          </div>
          <Switch
            id="dna-enabled-switch"
            aria-label="Apply my DNA writing style"
            checked={tenantOff ? false : checked}
            disabled={tenantOff || updateMutation.isPending}
            onCheckedChange={handleToggle}
          />
        </div>
      </CardContent>
    </Card>
  );
}
