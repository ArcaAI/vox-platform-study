'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';

import { GatewayError } from '@/shared/api';
import { formatMicros, formatUnitRate } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';

import { useSupersedeSellRate } from '../api/hooks';
import type { SellRate } from '../api/types';

/**
 * Supersede one SELL rate row (TASK-638 §7) — the write half of the rate card.
 *
 * A supersede REPRICES a row: the dimensions (capability · unit · provider ·
 * plan tier) are inherited server-side and shown read-only here, because
 * re-shaping a row is a different intent (new row + supersede) and must stay
 * two auditable actions rather than one ambiguous edit.
 *
 * This is real money on a tenant-facing card, so the dialog states the price in
 * BOTH micros and currency before submit, and never pre-fills a new price — the
 * operator types the number they mean.
 */
export function SupersedeRateDialog({ rate, onClose }: { rate: SellRate | null; onClose: () => void }) {
  if (!rate) return null;
  // Keyed remount gives every row a FRESH form: a price left over from the
  // previously-opened row would be the most dangerous possible default.
  return <SupersedeRateForm key={rate.id} rate={rate} onClose={onClose} />;
}

function SupersedeRateForm({ rate, onClose }: { rate: SellRate; onClose: () => void }) {
  const supersede = useSupersedeSellRate();
  const [micros, setMicros] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [bookVersion, setBookVersion] = useState('');

  // A PLAN_FEE is a whole-period amount; a USAGE_UNIT row is a sub-cent
  // per-unit rate that needs the 6-decimal formatter to be legible at all.
  const priceOf = (value: string) =>
    rate.rowKind === 'PLAN_FEE' ? formatMicros(value, rate.currency) : formatUnitRate(value, rate.currency);

  const parsedMicros = /^\d{1,30}$/.test(micros.trim()) ? micros.trim() : null;
  const canSubmit = parsedMicros !== null && effectiveFrom !== '' && bookVersion.trim() !== '' && !supersede.isPending;

  function submit() {
    if (!parsedMicros) return;
    supersede.mutate(
      {
        id: rate.id,
        version: rate.version,
        body: {
          unitPriceMicros: parsedMicros,
          // Day-granular input; the card is effective-dated to the instant, so
          // anchor at UTC midnight — the same boundary the invoice engine rates on.
          effectiveFrom: new Date(`${effectiveFrom}T00:00:00.000Z`).toISOString(),
          bookVersion: bookVersion.trim(),
        },
      },
      {
        onSuccess: () => {
          toast.success(`Rate superseded — ${priceOf(parsedMicros)} from ${effectiveFrom}`);
          onClose();
        },
        onError: (err) => {
          if (err instanceof GatewayError && (err.isVersionConflict || err.isMissingPrecondition)) return;
          toast.error(err instanceof GatewayError ? err.message : 'Could not supersede the rate.');
        },
      },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Supersede rate</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <OccConflictAlert error={supersede.error} onReload={onClose} />

          <dl className="bg-muted/40 grid grid-cols-2 gap-x-6 gap-y-1 rounded-md p-3 text-sm">
            {(
              [
                ['Row kind', rate.rowKind],
                ['Capability', rate.capability ?? '—'],
                ['Unit', rate.unit ?? '—'],
                ['Provider', rate.provider ?? 'any'],
                ['Plan tier', rate.planTier ?? 'any'],
                ['Current rate', `${rate.unitPriceMicros}µ · ${priceOf(rate.unitPriceMicros)}`],
              ] as Array<[string, string]>
            ).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground text-xs">
            Dimensions are inherited — a supersede reprices this row. To change what it is keyed on, create a new row and supersede this one.
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="supersede-micros">New rate (integer micros) *</Label>
            <Input
              id="supersede-micros"
              inputMode="numeric"
              placeholder="1390"
              value={micros}
              onChange={(event) => setMicros(event.target.value)}
              aria-describedby="supersede-micros-help"
            />
            <p id="supersede-micros-help" className="text-muted-foreground text-xs">
              {parsedMicros ? `= ${priceOf(parsedMicros)} per ${rate.unit ?? 'period'}` : 'Whole micros only (1e-6 USD), no decimal point.'}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="supersede-from">Effective from (UTC) *</Label>
            <Input id="supersede-from" type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
            <p className="text-muted-foreground text-xs">The old row closes at this instant; windows abut exactly, so no period is ever unrated.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="supersede-book">Book version *</Label>
            <Input id="supersede-book" placeholder="2026-09-01-commercial-v3" value={bookVersion} onChange={(event) => setBookVersion(event.target.value)} />
            <p className="text-muted-foreground text-xs">Labels the successor so an invoice can name the card it was rated on.</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSubmit}>
            Supersede
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
