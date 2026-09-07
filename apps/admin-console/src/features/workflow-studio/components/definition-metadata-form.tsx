'use client';

/**
 * `DefinitionMetadataForm` — a SHORT Dialog (rule 11 §1: dialogs stay for short confirmations —
 * two fields qualifies) over the definition's `name`/`description`. Controlled state only, no
 * `react-hook-form`.
 *
 * Fires `onNameChange`/`onDescriptionChange` on every keystroke rather than gating behind its own
 * Save button. TASK-893 OD-7 removed autosave, so those no longer feed a debounced schedule —
 * they STAGE the edit (the caller marks the definition dirty) and it is written by the studio's
 * one explicit Save, alongside the graph. One Save for the whole definition, not two.
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
