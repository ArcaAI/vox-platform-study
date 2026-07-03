import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Spinner } from '@arcaai/ui/spinner';
import { StatusBadge } from '@arcaai/ui/components/shared';
import type { PromptTemplate } from '@arcaai/vox';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';
import { categoryLabel, promptStatusLabel, promptStatusRole } from './instruction-draft';

/**
 * Single-select picker that wires a department default-agent slot to one of the
 * department's published/draft instructions. The summary slots persist via
 * `usePrompts.assignToDepartment`; the DNA writing-style slot persists via
 * `useDepartments.updatePromptConfig` (both handled by the caller's `onConfirm`).
 */
export function AssignSlotDialog({
  open,
  onOpenChange,
  slotLabel,
  options,
  currentId,
  isSaving,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slotLabel: string;
  options: PromptTemplate[];
  currentId?: string | null;
  isSaving: boolean;
  onConfirm: (promptId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(currentId ?? null);

  useEffect(() => {
    if (open) setSelected(currentId ?? null);
  }, [open, currentId]);

  const canSave = selected != null && selected !== currentId && !isSaving;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-lg', MOBILE_DIALOG_CONTENT)}>
        <DialogHeader>
          <DialogTitle>Assign {slotLabel}</DialogTitle>
          <DialogDescription>Choose the department instruction that powers this default agent.</DialogDescription>
        </DialogHeader>

        {/* Full-screen on mobile: drop the height cap so the list uses the viewport (the dialog itself scrolls). */}
        <div role="radiogroup" aria-label={`${slotLabel} instruction`} className="max-h-80 space-y-1.5 overflow-y-auto py-2 max-sm:max-h-none">
          {options.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">No instructions in this department yet.</p>
          ) : (
            options.map((p) => {
              const active = selected === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSelected(p.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
                    'hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'border-primary bg-primary/5' : 'border-border',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-full border',
                      active ? 'border-primary' : 'border-muted-foreground/40',
                    )}
                  >
                    {active ? <Check className="size-3 text-primary" /> : null}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{p.name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {categoryLabel(p.category)} · v{p.currentVersionNumber}
                    </span>
                  </span>
                  <StatusBadge label={promptStatusLabel(p.status)} colorRole={promptStatusRole(p.status)} />
                </button>
              );
            })
          )}
        </div>

        <DialogFooter className={MOBILE_DIALOG_FOOTER}>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" disabled={!canSave} onClick={() => selected && onConfirm(selected)}>
            {isSaving ? <Spinner className="size-4" /> : 'Assign instruction'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
