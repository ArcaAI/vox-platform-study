'use client';

/**
 * Shape tab: the document title, the global instruction, the ORDERED section
 * list, and the publish flow over `POST :id/publish`.
 *
 * The three authoring surfaces are kept apart on purpose (`document-template-
 * shape.ts`): `form` governs the FORM a section's value takes, the per-section
 * `instruction` governs what THAT section is for, and `globalInstruction`
 * governs how the whole document reads. A single prompt blob would express all
 * three at once and none of them separately — unversionable, untestable and
 * un-diffable. The editor mirrors that separation rather than collapsing it
 * back into one box.
 *
 * Publish surfaces the server's actual rejection reasons rather than a generic
 * error: a structural 400 lists every `problems[]` entry inline (the validator
 * returns them all at once, so an admin does not discover a ten-section
 * document's faults one round-trip at a time), and a refused breaking change
 * lists every break and offers an explicit acknowledgement — never a silent
 * retry.
 */

import { useId, useState } from 'react';
import { IconAlertTriangle, IconFileText, IconPlus } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@arcaai/ui/components/shadcn/accordion';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { EmptyState } from '@/shared/state/empty-state';
import { usePublishDocumentTemplate } from '../api/hooks';
import { MAX_DOCUMENT_SECTIONS, soapStarterShape, type DocumentSectionDeclaration, type DocumentTemplateShape } from '../api/types';
import { publishRejection } from '../lib/publish-error';
import { moveSection } from '../lib/section-order';
import { SectionForm } from './section-form';

function defaultSection(): DocumentSectionDeclaration {
  // `required` is left UNSET, so the shape carries the platform default of
  // false. A new section is optional until someone decides otherwise — D-21's
  // default expressed in the authoring path, not just in the compiler.
  return { key: '', title: '', form: 'PROSE' };
}

export function ShapeEditor({
  templateId,
  shape,
  onShapeChange,
  onPublished,
}: {
  templateId: string;
  shape: DocumentTemplateShape;
  onShapeChange: (next: DocumentTemplateShape) => void;
  onPublished: () => void;
}) {
  const uid = useId();
  const publish = usePublishDocumentTemplate();
  const [changeReason, setChangeReason] = useState('');
  const [breakingChanges, setBreakingChanges] = useState<string[] | null>(null);
  const problems = publish.error instanceof GatewayError ? (publishRejection(publish.error)?.problems ?? null) : null;

  const sections = shape.sections;
  const requiredCount = sections.filter((section) => section.required).length;

  function updateSection(index: number, next: DocumentSectionDeclaration) {
    onShapeChange({ ...shape, sections: sections.map((section, i) => (i === index ? next : section)) });
  }

  function removeSection(index: number) {
    onShapeChange({ ...shape, sections: sections.filter((_, i) => i !== index) });
  }

  function addSection() {
    onShapeChange({ ...shape, sections: [...sections, defaultSection()] });
  }

  function handleMove(index: number, delta: -1 | 1) {
    const next = moveSection(sections, index, delta);
    if (next === sections) return; // edge — no draft change
    onShapeChange({ ...shape, sections: next });
  }

  function runPublish(allowBreakingChange?: boolean) {
    publish.mutate(
      { id: templateId, body: { shape, changeReason: changeReason.trim() || undefined, allowBreakingChange } },
      {
        onSuccess: () => {
          toast.success('Template published');
          setBreakingChanges(null);
          setChangeReason('');
          onPublished();
        },
        onError: (error) => {
          const rejection = publishRejection(error);
          if (rejection?.breakingChanges) {
            setBreakingChanges(rejection.breakingChanges);
            return;
          }
          setBreakingChanges(null);
          if (rejection?.problems) return; // rendered inline below — no redundant toast
          toast.error(error instanceof GatewayError ? error.message : 'Could not publish the template.');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-title`}>
            Document title{' '}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </Label>
          <Input
            id={`${uid}-title`}
            value={shape.title}
            onChange={(event) => onShapeChange({ ...shape, title: event.target.value })}
            placeholder="Discharge Summary"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-global-instruction`}>Global instruction</Label>
          <Textarea
            id={`${uid}-global-instruction`}
            value={shape.globalInstruction ?? ''}
            onChange={(event) => onShapeChange({ ...shape, globalInstruction: event.target.value || undefined })}
            rows={3}
            placeholder="Be concise and faithful to the transcript; never fabricate findings."
          />
          <p className="text-muted-foreground text-xs">How the WHOLE document should be written. What each section is for belongs on that section.</p>
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-sm font-medium">
              Sections ({sections.length}
              {sections.length > 0 ? ` · ${requiredCount} required` : ''})
            </h3>
            <p className="text-muted-foreground text-xs">In order. The generated document follows this order exactly.</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={addSection} disabled={sections.length >= MAX_DOCUMENT_SECTIONS}>
            <IconPlus aria-hidden />
            Add section
          </Button>
        </div>

        {sections.length === 0 ? (
          <EmptyState
            icon={IconFileText}
            title="No sections yet"
            description="A document shape is an ordered list of sections. Add one, or start from the platform SOAP shape and edit it."
            action={
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={addSection}>
                  <IconPlus aria-hidden />
                  Add section
                </Button>
                <Button type="button" variant="outline" onClick={() => onShapeChange({ ...soapStarterShape(), title: shape.title || soapStarterShape().title })}>
                  Start from SOAP
                </Button>
              </div>
            }
          />
        ) : (
          <Accordion type="multiple" className="rounded-md border px-3">
            {sections.map((section, index) => (
              <AccordionItem key={index} value={`section-${index}`}>
                <AccordionTrigger>
                  <span className="flex flex-wrap items-center gap-2 text-left">
                    <span className="text-muted-foreground font-mono text-xs">{index + 1}</span>
                    <span className="font-mono text-sm">{section.key || `section ${index + 1}`}</span>
                    <Badge variant="outline">{section.form}</Badge>
                    {section.required ? <Badge variant="secondary">Required</Badge> : null}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <SectionForm
                    section={section}
                    index={index}
                    count={sections.length}
                    onChange={(next) => updateSection(index, next)}
                    onMove={(delta) => handleMove(index, delta)}
                    onRemove={() => removeSection(index)}
                  />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Publish</h3>
        <p className="text-muted-foreground text-sm">
          Publishing validates the shape, compiles it into the strict decoding schema, and freezes both onto a new immutable version — then pins it.
          Re-publishing an identical shape is a no-op.
        </p>

        {problems && problems.length > 0 ? (
          <Alert variant="destructive">
            <IconAlertTriangle aria-hidden />
            <AlertTitle>The shape is not publishable</AlertTitle>
            <AlertDescription>
              <ul className="flex flex-col gap-0.5">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {breakingChanges ? (
          <Alert variant="destructive">
            <IconAlertTriangle aria-hidden />
            <AlertTitle>This change breaks readers built against the current version</AlertTitle>
            <AlertDescription>
              <ul className="flex flex-col gap-0.5">
                {breakingChanges.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
              <div className="mt-2 flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setBreakingChanges(null)}>
                  Cancel
                </Button>
                <Button type="button" variant="destructive" size="sm" disabled={publish.isPending} onClick={() => runPublish(true)}>
                  {publish.isPending ? <Spinner /> : null}
                  Publish anyway
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${uid}-change-reason`}>Change reason (optional)</Label>
              <Input
                id={`${uid}-change-reason`}
                value={changeReason}
                onChange={(event) => setChangeReason(event.target.value)}
                placeholder="Add a discharge medications section for the cardiology ward"
              />
            </div>
            <div className="flex justify-end">
              <Button type="button" disabled={sections.length === 0 || !shape.title.trim() || publish.isPending} onClick={() => runPublish()}>
                {publish.isPending ? <Spinner /> : null}
                Publish
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
