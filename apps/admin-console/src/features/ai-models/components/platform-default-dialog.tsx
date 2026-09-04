'use client';

import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { useSetModelPlatformDefault } from '../api/hooks';
import type { AiModel, AiTaskKind } from '../api/types';
import { TASK_KIND_LABELS, TASK_KIND_OPTIONS } from './model-meta';

/**
 * The super-admin "platform default for task" election (README §3.7). Ticking
 * a task moves the default here — the gateway clears it from whichever row
 * held it — so the copy says so. Short confirmation-style dialog, not a
 * record editor (rule 11 §1 Dialogs).
 */
export function PlatformDefaultDialog({ model, open, onOpenChange }: { model: AiModel | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const uid = useId();
  const mutation = useSetModelPlatformDefault();
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [tasks, setTasks] = useState<AiTaskKind[]>([]);

  // Seed during render from the row the dialog was opened for.
  const seedKey = open && model ? model.id : null;
  if (seedKey !== seededFor) {
    setSeededFor(seedKey);
    setTasks(model?.isPlatformDefaultFor ?? []);
  }

  function toggle(task: AiTaskKind, checked: boolean) {
    setTasks((current) => (checked ? [...new Set([...current, task])] : current.filter((t) => t !== task)));
  }

  function save() {
    if (!model) return;
    mutation.mutate(
      { id: model.id, tasks },
      {
        onSuccess: () => {
          toast.success(tasks.length > 0 ? `${model.name} is now the platform default for ${tasks.map((t) => TASK_KIND_LABELS[t]).join(', ')}` : `${model.name} withdrawn from every platform default`);
          onOpenChange(false);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent className="flex flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Platform default for tasks</DialogTitle>
          <DialogDescription>
            Tasks <span className="text-foreground font-medium">{model?.name}</span> is the platform default for. Ticking a task moves the default
            here from whichever model held it; every tenant without its own selection inherits it.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" aria-label="Tasks">
          {TASK_KIND_OPTIONS.map((task) => {
            const id = `${uid}-${task}`;
            return (
              <li key={task} className="flex items-center gap-2">
                <Checkbox id={id} checked={tasks.includes(task)} onCheckedChange={(checked) => toggle(task, checked === true)} />
                <Label htmlFor={id}>{TASK_KIND_LABELS[task]}</Label>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={mutation.isPending || model?.resourceStatus !== 'ENABLED'}>
            {mutation.isPending ? <Spinner /> : null}
            Save defaults
          </Button>
        </DialogFooter>
        {model && model.resourceStatus !== 'ENABLED' ? (
          <p className="text-muted-foreground text-xs">Only an enabled model can be a platform default.</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
