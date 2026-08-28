'use client';

/**
 * One section of a document shape: key, title, form, its OWN instruction, and
 * whether it may be left empty.
 *
 * **The form allow-list is enforced here by construction** — `form` renders as
 * a closed `<Select>` populated only from `DOCUMENT_SECTION_FORMS`, so an
 * author cannot even TYPE a fourth form. The server re-enforces it at publish;
 * this makes the wrong state unrepresentable rather than merely rejected later.
 * Same posture as the context-schema `KindForm`'s primitive select.
 *
 * `required` is the D-21 control, and it is deliberately the one field with
 * prose explaining its consequence: leaving a section optional lets the model
 * emit `null` for "not discussed", while marking it required forbids the
 * decoder from representing absence at all — which is how four required SOAP
 * headings produced invented examination findings. It defaults OFF and the copy
 * says why.
 *
 * `fields` (the JSON Schema subset for a STRUCTURED section) is authored in the
 * shared `CodeEditor`, the house pattern for any JSON value (rule 11
 * anti-pattern table) — never a bare `<Textarea>`.
 */

import { useId } from 'react';
import { IconArrowDown, IconArrowUp, IconTrash } from '@tabler/icons-react';
import { CodeEditor } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { authorableJsonSchemaProblems } from '@arcaai/json-schema-subset';
import { DOCUMENT_SECTION_FORMS, type DocumentSectionDeclaration, type DocumentSectionForm } from '../api/types';

const FORM_HINTS: Record<DocumentSectionForm, string> = {
  PROSE: 'Free-running clinical prose.',
  BULLETS: 'A list of short points.',
  STRUCTURED: 'A JSON object constrained by the fields below.',
};

export function SectionForm({
  section,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  section: DocumentSectionDeclaration;
  index: number;
  count: number;
  onChange: (next: DocumentSectionDeclaration) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const uid = useId();
  const fieldsText = JSON.stringify(section.fields ?? {}, null, 2);
  const fieldsProblems = section.form === 'STRUCTURED' ? authorableJsonSchemaProblems(section.fields ?? {}) : [];

  function patch(next: Partial<DocumentSectionDeclaration>) {
    onChange({ ...section, ...next });
  }

  function handleFieldsChange(text: string) {
    try {
      patch({ fields: JSON.parse(text) as Record<string, unknown> });
    } catch {
      // Invalid JSON mid-edit — CodeEditor's own toolbar already flags it;
      // don't propagate an unparsable value into the draft.
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Ordering is authorial intent, so it is an edit — and it is offered as
          buttons, which is WCAG 2.5.7's single-pointer alternative by
          construction rather than a drag surface plus a fallback. */}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">
          Position {index + 1} of {count}
        </span>
        <Button type="button" variant="outline" size="sm" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move ${section.title || section.key || 'section'} up`}>
          <IconArrowUp aria-hidden />
          Up
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
          aria-label={`Move ${section.title || section.key || 'section'} down`}
        >
          <IconArrowDown aria-hidden />
          Down
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-key`}>
            Key{' '}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </Label>
          <Input
            id={`${uid}-key`}
            value={section.key}
            onChange={(event) => patch({ key: event.target.value })}
            placeholder="discharge_medications"
            className="font-mono"
            autoComplete="off"
            required
          />
          <p className="text-muted-foreground text-xs">Stable identifier — lowercase letters, digits, underscores (2-48 chars). Renaming one is a BREAKING change.</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-title`}>
            Title{' '}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </Label>
          <Input id={`${uid}-title`} value={section.title} onChange={(event) => patch({ title: event.target.value })} placeholder="Discharge Medications" required />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-form`}>
            Form{' '}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </Label>
          {/* CLOSED select — the enforcement point: an author cannot choose or type a fourth form. */}
          <Select value={section.form} onValueChange={(next) => patch({ form: next as DocumentSectionForm })}>
            <SelectTrigger id={`${uid}-form`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOCUMENT_SECTION_FORMS.map((form) => (
                <SelectItem key={form} value={form}>
                  {form}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{FORM_HINTS[section.form]}</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-max-chars`}>Max characters</Label>
          <Input
            id={`${uid}-max-chars`}
            type="number"
            min={1}
            inputMode="numeric"
            value={section.maxChars ?? ''}
            onChange={(event) => {
              const raw = event.target.value.trim();
              const parsed = Number(raw);
              patch({ maxChars: raw === '' || !Number.isFinite(parsed) ? undefined : parsed });
            }}
          />
          <p className="text-muted-foreground text-xs">Advisory ceiling passed to the model. Optional.</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-instruction`}>Instruction</Label>
        <Textarea
          id={`${uid}-instruction`}
          value={section.instruction ?? ''}
          onChange={(event) => patch({ instruction: event.target.value || undefined })}
          rows={2}
          placeholder="What this section is for — e.g. Medications the patient leaves with, including dose and duration."
        />
        <p className="text-muted-foreground text-xs">Governs THIS section only. How the whole document should read belongs in the global instruction.</p>
      </div>

      <div className="flex flex-col gap-2 rounded-md border p-3">
        <div className="flex items-center gap-2">
          <Checkbox id={`${uid}-required`} checked={section.required === true} onCheckedChange={(checked) => patch({ required: checked === true })} />
          <Label htmlFor={`${uid}-required`} className="font-normal">
            Required — the model must always produce content for this section
          </Label>
        </div>
        <p className="text-muted-foreground text-xs">
          {section.required
            ? 'The decoder cannot represent "not discussed" for this section, so it will write something even when the consultation covered nothing. Only require a section a clinician genuinely always fills.'
            : 'Optional (recommended). The section compiles to a nullable property, so the model can record that it was not discussed instead of inventing content to fill the heading.'}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-description`}>Description</Label>
        <Textarea
          id={`${uid}-description`}
          value={section.description ?? ''}
          onChange={(event) => patch({ description: event.target.value || undefined })}
          rows={2}
        />
      </div>

      {section.form === 'STRUCTURED' ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-fields`}>
            Fields (JSON Schema){' '}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </Label>
          <CodeEditor aria-label={`Fields JSON Schema for ${section.title || section.key || 'section'}`} value={fieldsText} onChange={handleFieldsChange} language="json" className="min-h-40" />
          {fieldsProblems.length > 0 ? (
            <ul className="text-destructive flex flex-col gap-0.5 text-xs">
              {fieldsProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-xs">
              Required for STRUCTURED — validated against the authorable subset (no if/then/else; oneOf needs a discriminator).
            </p>
          )}
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onRemove}>
          <IconTrash aria-hidden />
          Remove section
        </Button>
      </div>
    </div>
  );
}
