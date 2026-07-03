import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Spinner } from '@arcaai/ui/spinner';
import { Switch } from '@arcaai/ui/switch';
import type { PlanEntitlement, UpdatePlanEntitlementInput } from '@arcaai/vox';
import { useEffect, useState, type FormEvent } from 'react';
import { FEATURE_FIELDS, LIMIT_FIELDS, MODEL_TIERS, RATE_LIMIT_TIERS, limitInputValue, parseLimitInput } from './entitlement-fields';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';
import { planLabel, type TenantPlan } from '@/features/tenants/tenant-plan';

/**
 * Super-admin edit of one plan-matrix row (Q1). Blank numeric input = unlimited
 * (`null`). Submits the full field set plus `expectedVersion` (OCC → 412 on
 * drift; the parent refetches and reopens).
 */
export function PlanEditDialog({
  plan,
  open,
  onOpenChange,
  onSave,
}: {
  plan: PlanEntitlement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (planKey: string, input: UpdatePlanEntitlementInput) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [modelTier, setModelTier] = useState<string>('base');
  const [rateLimitTier, setRateLimitTier] = useState<string>('default');

  useEffect(() => {
    if (!open || !plan) return;
    setLimits(Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, limitInputValue(plan[f.key])])));
    setFeatures(Object.fromEntries(FEATURE_FIELDS.map((f) => [f.key, Boolean(plan[f.key])])));
    setModelTier(plan.modelTier || 'base');
    setRateLimitTier(plan.rateLimitTier || 'default');
  }, [open, plan]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!plan) return;
    setSaving(true);
    try {
      const input: UpdatePlanEntitlementInput = { expectedVersion: plan.version, modelTier, rateLimitTier };
      for (const f of LIMIT_FIELDS) input[f.key] = parseLimitInput(limits[f.key] ?? '');
      for (const f of FEATURE_FIELDS) input[f.key] = Boolean(features[f.key]);
      await onSave(plan.plan, input);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('flex h-[70vh] flex-col sm:max-w-[60vw]', MOBILE_DIALOG_CONTENT)}>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>Edit {plan ? planLabel(plan.plan as TenantPlan) : ''} plan defaults</DialogTitle>
            <DialogDescription>
              Blank = unlimited. Changes apply to every tenant on this plan unless a per-tenant override is set. Optimistic concurrency is enforced.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto py-4">
            <div>
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Limits</h4>
              <div className="grid grid-cols-2 gap-3">
                {LIMIT_FIELDS.map((f) => (
                  <div key={f.key} className="flex flex-col gap-1.5">
                    <Label htmlFor={`plan-${f.key}`}>{f.label}</Label>
                    <Input
                      id={`plan-${f.key}`}
                      inputMode="numeric"
                      placeholder="Unlimited"
                      value={limits[f.key] ?? ''}
                      onChange={(e) => setLimits((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Features</h4>
              <div className="flex flex-col gap-3">
                {FEATURE_FIELDS.map((f) => (
                  <div key={f.key} className="flex items-center justify-between rounded-md border px-3 py-2">
                    <Label htmlFor={`plan-${f.key}`} className="cursor-pointer">
                      {f.label}
                    </Label>
                    <Switch
                      id={`plan-${f.key}`}
                      checked={Boolean(features[f.key])}
                      onCheckedChange={(v) => setFeatures((prev) => ({ ...prev, [f.key]: v }))}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-modelTier">Model tier</Label>
                <Select value={modelTier} onValueChange={setModelTier}>
                  <SelectTrigger id="plan-modelTier">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_TIERS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plan-rateTier">Rate-limit tier</Label>
                <Select value={rateLimitTier} onValueChange={setRateLimitTier}>
                  <SelectTrigger id="plan-rateTier">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RATE_LIMIT_TIERS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <DialogFooter className={cn('shrink-0', MOBILE_DIALOG_FOOTER)}>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={saving}>
              {saving ? <Spinner className="size-4" /> : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
