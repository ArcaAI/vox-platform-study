'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { RadioGroup, RadioGroupItem } from '@arcaai/ui/components/shadcn/radio-group';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { formatBytes } from '@/shared/format';
import { residencyErrorMessage } from '@/shared/residency';
import { useLinkRuntimeKey } from '../api';
import type { LinkInstanceDialogProps } from './residency-dialog-contracts';

const NONE = '__none__';

export function LinkInstanceDialog({ open, onOpenChange, service, model, onLinked }: LinkInstanceDialogProps) {
  const link = useLinkRuntimeKey();
  const { candidates, reportedKey } = model.identity;
  const [choice, setChoice] = useState<string>(() => candidates.find((c) => c.strength === 'strong')?.aiModelId ?? NONE);
  const [pending, setPending] = useState(false);

  // A refreshed catalogue can change the candidates: re-pick the strong one if the current choice vanished.
  const candidateIds = candidates.map((c) => c.aiModelId).join('|');
  const [seenCandidates, setSeenCandidates] = useState(candidateIds);
  if (seenCandidates !== candidateIds) {
    setSeenCandidates(candidateIds);
    setChoice(candidates.find((c) => c.strength === 'strong')?.aiModelId ?? NONE);
  }

  const bytes = model.residency?.bytes ?? model.size.bytes;
  const picked = candidates.find((c) => c.aiModelId === choice);

  async function submit() {
    if (choice === NONE || !reportedKey) {
      toast.success('Left unmatched');
      onOpenChange(false);
      return;
    }
    setPending(true);
    try {
      await link.mutateAsync({ service: service.service, runtimeKey: reportedKey, aiModelId: choice });
      toast.success(`Linked ${reportedKey} to ${picked?.name ?? 'the catalogue model'}.`);
      onLinked?.();
      onOpenChange(false);
    } catch (error) {
      const reason = residencyErrorMessage(error, '');
      toast.error(reason ? `Couldn't link ${reportedKey}: ${reason}` : `Couldn't link ${reportedKey}.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b p-4">
          <DialogTitle>Link a running instance to the catalogue</DialogTitle>
          <DialogDescription>
            {service.label} reports a model HOPE cannot match. Pick the catalogue model it is, so usage, pinning and budgets apply to it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
          <section className="flex flex-col gap-1.5" aria-labelledby="li-running-h">
            <h3 id="li-running-h" className="text-sm font-medium">
              Running instance
            </h3>
            <div className="bg-muted rounded-md p-3 font-mono text-sm break-all">{reportedKey ?? model.modelRef}</div>
            <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
              <span>{service.label}</span>
              {model.format ? <span>{model.format}</span> : null}
              {bytes !== null ? (
                <span>
                  {formatBytes(bytes)} {model.residency?.bytesSource === 'measured' ? 'measured' : 'estimated'}
                </span>
              ) : null}
              {model.residency ? <span>{model.residency.device}</span> : null}
            </div>
          </section>

          <RadioGroup value={choice} onValueChange={setChoice} aria-label="It is this catalogue model" className="gap-3">
            {candidates.map((c) => (
              <div key={c.aiModelId} className="flex items-start gap-2">
                <RadioGroupItem value={c.aiModelId} id={`li-${c.aiModelId}`} className="mt-1" />
                <Label htmlFor={`li-${c.aiModelId}`} className="flex flex-1 flex-col gap-0.5 font-normal">
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    <Badge variant={c.strength === 'strong' ? 'default' : 'outline'}>{c.strength === 'strong' ? 'Strong match' : 'Weak match'}</Badge>
                  </span>
                  <span className="text-muted-foreground font-mono text-xs">{c.slug}</span>
                  <span className="text-muted-foreground text-xs">{c.reason}</span>
                </Label>
              </div>
            ))}
            <div className="flex items-start gap-2">
              <RadioGroupItem value={NONE} id="li-none" className="mt-1" />
              <Label htmlFor="li-none" className="flex flex-1 flex-col gap-0.5 font-normal">
                <span className="font-medium">None of these</span>
                <span className="text-muted-foreground text-xs">Keep it listed as unmatched. Its memory still counts against GPU budgets.</span>
              </Label>
            </div>
          </RadioGroup>

          <section className="flex flex-col gap-1.5" aria-labelledby="li-changes-h">
            <h3 id="li-changes-h" className="text-sm font-medium">
              What changes
            </h3>
            <ul className="text-muted-foreground list-disc pl-5 text-sm">
              <li>
                {picked
                  ? `${picked.name} shows as loaded${bytes !== null ? `, ${formatBytes(bytes)}` : ''}.`
                  : 'Nothing changes; the instance stays unmatched.'}
              </li>
              <li>Any recommendation to load it again is withdrawn.</li>
              <li>Enforce mode will no longer try to load a second copy.</li>
              <li>Recorded in the audit log as a mapping change, not a load.</li>
            </ul>
          </section>
        </div>
        <DialogFooter className="shrink-0 border-t p-4 sm:justify-end">
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={() => void submit()}>
            {pending ? <Spinner /> : null}
            {choice === NONE ? 'Keep unmatched' : 'Link instance'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
