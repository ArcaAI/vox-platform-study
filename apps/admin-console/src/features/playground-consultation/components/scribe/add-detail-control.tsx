'use client';

/**
 * D-17 — the add-details-during-consultation affordance. `useArca()` exposes
 * `context.addCaseNote` (and `addAttachment`), but the screen never called
 * either: a clinician had no way to hand the loop a supplementary detail
 * mid-consultation (e.g. an allergy mentioned off the recorded transcript).
 * This is a self-contained control — the caller supplies the write
 * (`context.addCaseNote`) and this component owns only the popover + form.
 */

import { useState } from 'react';
import { IconNotes } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Popover, PopoverContent, PopoverTrigger } from '@arcaai/ui/components/shadcn/popover';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';

export interface AddDetailControlProps {
  disabled?: boolean;
  /** Writes the detail as a case note via the SDK's `context.addCaseNote`. */
  onAdd: (content: string) => Promise<void>;
}

export function AddDetailControl({ disabled = false, onAdd }: AddDetailControlProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);

  async function submit() {
    const content = value.trim();
    if (!content) return;
    setPending(true);
    try {
      await onAdd(content);
      toast.success('Detail added to the consultation');
      setValue('');
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : 'Could not add the detail');
    } finally {
      setPending(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
      <PopoverTrigger asChild>
        <Button variant="outline" disabled={disabled} className="shrink-0">
          <IconNotes aria-hidden />
          Add detail
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex flex-col gap-2">
          <Label htmlFor="add-detail-content">Add a detail to this consultation</Label>
          <Textarea
            id="add-detail-content"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="e.g. Patient reports a new penicillin allergy"
            rows={4}
            disabled={pending}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" onClick={() => void submit()} disabled={pending || !value.trim()}>
              {pending ? <Spinner aria-hidden /> : null}
              Add
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
