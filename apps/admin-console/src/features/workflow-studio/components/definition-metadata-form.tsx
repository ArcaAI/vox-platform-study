'use client';

/**
 * `DefinitionMetadataForm` (TASK-719 Task 15 remainder — README §7 "Honesty gap: only the
 * `graph` field autosaves in this pass"). A SHORT Dialog (rule 11 §1: dialogs stay for short
 * confirmations — two fields qualifies) over the definition's `name`/`description`. Controlled
 * state only, no `react-hook-form` (README §2.5). Deliberately fires `onNameChange`/
 * `onDescriptionChange` on every keystroke rather than gating behind a Save button — the caller
 * (`WorkflowStudioEditor`) feeds those straight into the SAME debounced `useAutosave.schedule`
 * the graph uses, so name/description edits autosave exactly like graph edits do.
 */
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, FieldDescription, FieldLabel, Input } from '@arcaai/ui';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';

export interface DefinitionMetadataFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  description: string;
  onNameChange: (next: string) => void;
  onDescriptionChange: (next: string) => void;
  readOnly?: boolean;
}

export function DefinitionMetadataForm({ open, onOpenChange, name, description, onNameChange, onDescriptionChange, readOnly }: DefinitionMetadataFormProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Definition details</DialogTitle>
          <DialogDescription>Name and description autosave the same way graph edits do.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="definition-metadata-name">Name *</FieldLabel>
            <Input id="definition-metadata-name" value={name} disabled={readOnly} maxLength={160} onChange={(event) => onNameChange(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="definition-metadata-description">Description</FieldLabel>
            <FieldDescription>Shown to other tenant admins browsing the definitions list.</FieldDescription>
            <Textarea
              id="definition-metadata-description"
              value={description}
              disabled={readOnly}
              rows={4}
              maxLength={2000}
              onChange={(event) => onDescriptionChange(event.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
