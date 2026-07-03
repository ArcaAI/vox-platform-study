import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Spinner } from '@arcaai/ui/spinner';
import type { TenantEntitlementOverride, UpsertTenantOverrideInput } from '@arcaai/vox';
import { useEffect, useState, type FormEvent } from 'react';
import { ConfirmDelete } from '@/features/common/confirm-delete';
import { FEATURE_FIELDS, LIMIT_FIELDS, MODEL_TIERS, RATE_LIMIT_TIERS, limitInputValue, parseLimitInput } from './entitlement-fields';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER_DEEP } from '@/lib/responsive';
import { cn } from '@/lib/utils';

const INHERIT = '__inherit__';

/** tri-state feature: 'inherit' → null, 'on' → true, 'off' → false. */
function featureToState(v?: boolean | null): string {
  return v == null ? INHERIT : v ? 'on' : 'off';
}
function stateToFeature(s: string): boolean | null {
  return s === INHERIT ? null : s === 'on';
}

/**
 * Per-tenant override ("increase on demand", Q7). Every field defaults to
 * INHERIT (plan default); a set value overrides just that field. Clearing the
 * whole override reverts to plan inheritance (reversible — the row is nulled,
 * never deleted). OCC via `expectedVersion` when a row already exists.
 */
export function TenantOverrideDialog({
  tenantId,
  override,
  open,
  onOpenChange,
  onSave,
  onClear,
}: {
  tenantId: string;
  override: TenantEntitlementOverride | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (tenantId: string, input: UpsertTenantOverrideInput) => Promise<void>;
  onClear: (tenantId: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [features, setFeatures] = useState<Record<string, string>>({});
  const [modelTier, setModelTier] = useState<string>(INHERIT);
  const [rateLimitTier, setRateLimitTier] = useState<string>(INHERIT);
  const [perMinute, setPerMinute] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    setLimits(Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, limitInputValue(override?.[f.key])])));
    setFeatures(Object.fromEntries(FEATURE_FIELDS.map((f) => [f.key, featureToState(override?.[f.key])])));
    setModelTier(override?.modelTier ?? INHERIT);
    setRateLimitTier(override?.rateLimitTier ?? INHERIT);
    setPerMinute(override?.rateLimitPerMinute == null ? '' : String(override.rateLimitPerMinute));
  }, [open, override]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const input: UpsertTenantOverrideInput = {
        modelTier: modelTier === INHERIT ? null : modelTier,
        rateLimitTier: rateLimitTier === INHERIT ? null : rateLimitTier,
        rateLimitPerMinute: parseLimitInput(perMinute),
      };
      for (const f of LIMIT_FIELDS) input[f.key] = parseLimitInput(limits[f.key] ?? '');
      for (const f of FEATURE_FIELDS) input[f.key] = stateToFeature(features[f.key] ?? INHERIT);
      if (override) input.expectedVersion = override.version;
      await onSave(tenantId, input);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('flex h-[72vh] flex-col sm:max-w-[60vw]', MOBILE_DIALOG_CONTENT)}>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>Tenant override</DialogTitle>
            <DialogDescription>
              Blank / “Inherit” = use the plan default. Set a value to raise or lower just that capability for this tenant. Reversible — clearing
              reverts to the plan.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto py-4">
            <div>
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Limit overrides</h4>
              <div className="grid grid-cols-2 gap-3">
                {LIMIT_FIELDS.map((f) => (
                  <div key={f.key} className="flex flex-col gap-1.5">
                    <Label htmlFor={`ov-${f.key}`}>{f.label}</Label>
                    <Input
                      id={`ov-${f.key}`}
                      inputMode="numeric"
                      placeholder="Inherit"
                      value={limits[f.key] ?? ''}
                      onChange={(e) => setLimits((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Feature overrides</h4>
              <div className="grid grid-cols-3 gap-3">
                {FEATURE_FIELDS.map((f) => (
                  <div key={f.key} className="flex flex-col gap-1.5">
                    <Label htmlFor={`ov-${f.key}`}>{f.label}</Label>
                    <Select value={features[f.key] ?? INHERIT} onValueChange={(v) => setFeatures((prev) => ({ ...prev, [f.key]: v }))}>
                      <SelectTrigger id={`ov-${f.key}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={INHERIT}>Inherit</SelectItem>
                        <SelectItem value="on">Enabled</SelectItem>
                        <SelectItem value="off">Disabled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ov-modelTier">Model tier</Label>
                <Select value={modelTier} onValueChange={setModelTier}>
                  <SelectTrigger id="ov-modelTier">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>Inherit</SelectItem>
                    {MODEL_TIERS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ov-rateTier">Rate-limit tier</Label>
                <Select value={rateLimitTier} onValueChange={setRateLimitTier}>
                  <SelectTrigger id="ov-rateTier">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>Inherit</SelectItem>
                    {RATE_LIMIT_TIERS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ov-perMinute">Rate override (req/min)</Label>
                <Input id="ov-perMinute" inputMode="numeric" placeholder="Inherit" value={perMinute} onChange={(e) => setPerMinute(e.target.value)} />
              </div>
            </div>
          </div>

          <DialogFooter className={cn('shrink-0 sm:justify-between', MOBILE_DIALOG_FOOTER_DEEP)}>
            {override ? (
              <ConfirmDelete
                trigger={
                  <Button type="button" variant="outline" className="text-destructive">
                    Clear override
                  </Button>
                }
                title="Clear this tenant override?"
                description="Reverts every field to the plan default. This is reversible — the override row is nulled, not deleted."
                confirmLabel="Clear override"
                onConfirm={() => onClear(tenantId)}
              />
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={saving}>
                {saving ? <Spinner className="size-4" /> : 'Save override'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
