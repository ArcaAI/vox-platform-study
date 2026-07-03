import { Button } from '@arcaai/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import type { RateLimitTierPolicy, SetRateLimitTierInput } from '@arcaai/vox';
import { useEffect, useState } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';

/**
 * TASK-403 — tier baseline editor (design §5.3 "tier edit popover/dialog:
 * limit + ttl"). Controlled by the parent; submits only the fields the
 * operator changed (the API PATCHes per-field).
 */
export function TierEditDialog({
  tier,
  open,
  onOpenChange,
  onSave,
}: {
  tier: RateLimitTierPolicy | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (tier: string, input: SetRateLimitTierInput) => Promise<void>;
}) {
  const [limit, setLimit] = useState('');
  const [ttl, setTtl] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (tier) {
      setLimit(String(tier.limit));
      setTtl(String(tier.ttl));
    }
  }, [tier]);

  const limitNum = Number.parseInt(limit, 10);
  const ttlNum = Number.parseInt(ttl, 10);
  const valid = Number.isInteger(limitNum) && limitNum >= 1 && Number.isInteger(ttlNum) && ttlNum >= 1;

  const submit = async () => {
    if (!tier || !valid) return;
    setSaving(true);
    try {
      const input: SetRateLimitTierInput = {};
      if (limitNum !== tier.limit) input.limit = limitNum;
      if (ttlNum !== tier.ttl) input.ttl = ttlNum;
      if (Object.keys(input).length > 0) await onSave(tier.tier, input);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-sm', MOBILE_DIALOG_CONTENT)}>
        <DialogHeader>
          <DialogTitle>
            Edit tier <span className="font-mono">{tier?.tier}</span>
          </DialogTitle>
          <DialogDescription>Changes persist as rate-limit GlobalSettings and take effect live — no redeploy.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="tier-limit">Max requests per window</Label>
            <Input id="tier-limit" type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tier-ttl">Window length (ms)</Label>
            <Input id="tier-ttl" type="number" min={1} step={1000} value={ttl} onChange={(e) => setTtl(e.target.value)} />
          </div>
        </div>
        <DialogFooter className={MOBILE_DIALOG_FOOTER}>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || saving}>
            {saving ? 'Saving…' : 'Save tier'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
