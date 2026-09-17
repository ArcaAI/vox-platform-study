'use client';

/**
 * `CloneDefinitionDialog` — "make a new workflow from this one", and "start from a
 * platform template".
 *
 * A SHORT dialog, not a `DetailDrawer`: this collects two fields and confirms an action, which
 * is exactly what rule 11 §1 reserves dialogs for. Record detail stays in the drawer.
 *
 * PRESENTATIONAL, deliberately — it owns no query and no mutation, so the definitions list can
 * drive it with either a fixed source (the row you clicked) or the template library, and the
 * component stays testable without a QueryClient. Same posture as `PublishDialog`.
 *
 * The slug is pre-filled with `<source>_copy` HERE rather than derived on the server: the slug
 * is the workflow's public address (`POST /workflows/:slug/invoke`), so the platform proposes
 * and the tenant decides. See the ticket's D-3.
 */
import { useMemo, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
} from '@arcaai/ui';
import type { WorkflowDefinition } from '../api/types';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';

/** Mirrors the server's `targetSlug` grammar (`WORKFLOW_NODE_ID_PATTERN`). Client-side only —
 *  the DTO re-validates it; this exists so a typo costs no round trip. */
const SLUG_PATTERN = /^[a-z0-9_]{2,48}$/;

export interface CloneDefinitionSubmission {
  sourceId: string;
  targetSlug: string;
  name?: string;
}

export interface CloneDefinitionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row being cloned. `null` puts the dialog in "start from a platform template" mode. */
  source: WorkflowDefinition | null;
  /** The SYSTEM template library (`GET admin/workflow-definitions/templates`). */
  templates: WorkflowDefinition[];
  templatesLoading: boolean;
  onConfirm: (submission: CloneDefinitionSubmission) => void;
  confirming?: boolean;
  /** Server-side failure to surface — a 409 slug collision, a quota refusal, a 400 binding. */
  error?: string | null;
}

function suggestSlug(slug: string | undefined): string {
  if (!slug) return '';
  const suggestion = `${slug}_copy`;
  return suggestion.length <= 48 ? suggestion : suggestion.slice(0, 48);
}

export function CloneDefinitionDialog({
  open,
  onOpenChange,
  source,
  templates,
  templatesLoading,
  onConfirm,
  confirming,
  error,
}: CloneDefinitionDialogProps) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [targetSlug, setTargetSlug] = useState('');
  const [name, setName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const selected = useMemo<WorkflowDefinition | null>(
    () => source ?? templates.find((template) => template.id === selectedTemplateId) ?? null,
    [source, templates, selectedTemplateId],
  );

  // Re-seed the fields whenever what is being cloned changes — a different row, a newly picked
  // template, or a reopen. Adjusted DURING RENDER rather than in an effect (React's documented
  // "adjusting state when a prop changes" pattern): an effect would render once with the stale
  // suggestion and then again with the fresh one, which is the cascading render
  // `react-hooks/set-state-in-effect` exists to stop. Closing sets the key to null so the next
  // open re-seeds even for the same source.
  const seedKey = open ? (selected?.id ?? 'none') : null;
  const [seededFrom, setSeededFrom] = useState<string | null>(null);
  if (seedKey !== seededFrom) {
    setSeededFrom(seedKey);
    setTargetSlug(suggestSlug(selected?.slug));
    setName(selected ? `${selected.name} (copy)` : '');
    setLocalError(null);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);

    if (!selected) {
      setLocalError('Pick a template to clone.');
      return;
    }
    if (!SLUG_PATTERN.test(targetSlug)) {
      setLocalError('Slug must be 2-48 lowercase letters, digits or underscores.');
      return;
    }

    onConfirm({ sourceId: selected.id, targetSlug, name: name.trim() || undefined });
  }

  const message = localError ?? error ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG_SIZE_CLASS.md}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{source ? 'Clone this workflow' : 'Start from a platform template'}</DialogTitle>
            <DialogDescription>
              Creates a new draft workflow with its own slug, seeded from{' '}
              {source ? <span className="font-medium">{source.name}</span> : 'a platform template'}. Nothing about the original changes, and the
              clone is not published or active until you publish it.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="py-2">
            {source ? null : (
              <Field>
                <FieldLabel id="clone-template-label" asChild>
                  <span>Template *</span>
                </FieldLabel>
                <FieldDescription>Platform-provided workflows. Cloning copies the graph into your tenant so you can edit it.</FieldDescription>
                {templatesLoading ? (
                  <div className="flex flex-col gap-2" aria-hidden>
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-3/4" />
                  </div>
                ) : templates.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No platform templates are published yet. Clone one of your own workflows instead.</p>
                ) : (
                  <RadioGroup aria-labelledby="clone-template-label" value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                    {templates.map((template) => (
                      <div key={template.id} className="flex items-start gap-2">
                        <RadioGroupItem id={`clone-template-${template.id}`} value={template.id} className="mt-1" />
                        <Label htmlFor={`clone-template-${template.id}`} className="flex flex-col items-start gap-0.5 font-normal">
                          {/*
 The palette is a BADGE, not a run of mono text : the library now
                              mixes `consultation` example workflows with the `stt` transcription agent, and
                              cloning the wrong palette yields a workflow that cannot govern a consultation
                              at all. It has to be scannable at a glance. 
*/}
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium">{template.name}</span>
                            <Badge variant="outline">{template.paletteKey}</Badge>
                          </span>
                          <span className="text-muted-foreground font-mono text-xs">{template.slug}</span>
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                )}
              </Field>
            )}

            <Field data-invalid={message ? 'true' : undefined}>
              <FieldLabel htmlFor="clone-target-slug">New slug *</FieldLabel>
              <FieldDescription>The clone’s own lineage key and public address. Must not already be in use by this tenant.</FieldDescription>
              <Input
                id="clone-target-slug"
                value={targetSlug}
                onChange={(event) => setTargetSlug(event.target.value)}
                maxLength={48}
                autoComplete="off"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="clone-name">Name</FieldLabel>
              <Input id="clone-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={160} autoComplete="off" />
            </Field>

            {message ? <FieldError>{message}</FieldError> : null}
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>
              Cancel
            </Button>
            <Button type="submit" disabled={confirming}>
              {confirming ? 'Cloning…' : 'Clone'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
