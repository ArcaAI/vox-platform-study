'use client';

/**
 * Kind editor (key, label, primitive, PHI class, cardinality,
 * lifecycle, producedBy, a field builder, constraints, deprecation).
 *
 * **The primitive allow-list is enforced here by construction**: `primitive`
 * renders as a closed `<Select>` populated ONLY from `CONTEXT_PRIMITIVES` —
 * there is no free-text entry, so an author cannot even TYPE an unknown
 * primitive. The server re-enforces this at publish; the UI
 * makes the wrong state unrepresentable instead of merely rejecting it later.
 *
 * `fields` (the JSON Schema subset for a STRUCTURED kind) is authored in the
 * shared `CodeEditor` (`@arcaai/ui`) rather than a bespoke property-by-
 * property builder — the house pattern for any JSON/array value
 * (`11-ux-ui-principles.mdc` anti-pattern table) and the same shape the
 * server's `fields` document already is.
 *
 * ## Progressive disclosure
 *
 * Everything above is still here; what changed is how much of it an admin meets
 * at once. A STRUCTURED kind put 23 controls on screen simultaneously, which
 * reads as a form to be completed rather than a decision to be made. Three
 * groups now:
 *
 *   • **Basics** (open) — the six that decide what this kind IS and what a
 *     client must send: Key, Label, Primitive, Produced by, Required,
 *     Description.
 *   • **Field roles** (closed) — the `FieldRoleTable`, shown only for the shape
 *     that can carry one. Opening it is a deliberate act because a role changes
 *     how HOPE interprets a payload at `open`, not merely how it validates.
 *   • **Advanced** (closed) — PHI class, cardinality, lifecycle, the JSON
 *     Schema, constraints, deprecation, and Remove. Every one of these has a
 *     working default; an admin who never opens this group still authors a valid
 *     kind.
 *
 * The disclosures UNMOUNT their content when closed (Radix Collapsible's
 * default), which is what makes the first-sight control count real rather than
 * merely visual.
 */

import { useId, useState, type ReactNode } from 'react';
import { IconChevronRight, IconTrash } from '@tabler/icons-react';
import { CodeEditor } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@arcaai/ui/components/shadcn/collapsible';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { authorableJsonSchemaProblems } from '@arcaai/json-schema-subset';
import {
  CONTEXT_CARDINALITIES,
  CONTEXT_LIFECYCLES,
  CONTEXT_PHI_CLASSES,
  CONTEXT_PRIMITIVES,
  CONTEXT_PRODUCERS,
  type ContextCardinality,
  type ContextKindDeclaration,
  type ContextLifecycle,
  type ContextPhiClass,
  type ContextPrimitive,
  type ContextProducer,
} from '../api/types';
import { FieldRoleTable } from './field-role-table';

function stringifyFields(fields: Record<string, unknown> | undefined): string {
  return JSON.stringify(fields ?? {}, null, 2);
}

/** A closed-by-default group. Content is unmounted while closed, not merely hidden. */
function Disclosure({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" className="h-auto w-full justify-start gap-2 px-3 py-2 font-medium">
          <IconChevronRight aria-hidden className={open ? 'size-4 rotate-90 transition-transform' : 'size-4 transition-transform'} />
          {title}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4 border-t px-3 py-3">
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function KindForm({
  kind,
  index = 0,
  kinds,
  onChange,
  onRemove,
}: {
  kind: ContextKindDeclaration;
  /** This kind's position in `kinds` — the field-role table excludes it when checking "held elsewhere". */
  index?: number;
  /** Every kind in the current draft. Defaults to this kind alone, which is correct for a single-kind preview. */
  kinds?: ContextKindDeclaration[];
  onChange: (next: ContextKindDeclaration) => void;
  onRemove: () => void;
}) {
  const uid = useId();
  const allKinds = kinds ?? [kind];
  const fieldsText = stringifyFields(kind.fields);
  const fieldsProblems = kind.primitive === 'STRUCTURED' ? authorableJsonSchemaProblems(kind.fields ?? {}) : [];
  // The same shape `FieldRoleTable` renders for; asking it here keeps the
  // disclosure from appearing above an empty panel.
  const canCarryFieldRoles = kind.primitive === 'STRUCTURED' && kind.cardinality === 'ONE';

  function patch(next: Partial<ContextKindDeclaration>) {
    onChange({ ...kind, ...next });
  }

  function toggleProducer(producer: ContextProducer, checked: boolean) {
    const next = checked ? [...kind.producedBy, producer] : kind.producedBy.filter((entry) => entry !== producer);
    patch({ producedBy: next });
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
            value={kind.key}
            onChange={(event) => patch({ key: event.target.value })}
            placeholder="referral_letter"
            className="font-mono"
            autoComplete="off"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-label`}>
            Label{' '}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </Label>
          <Input
            id={`${uid}-label`}
            value={kind.label}
            onChange={(event) => patch({ label: event.target.value })}
            placeholder="Referral Letter"
            required
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-primitive`}>
            Primitive{' '}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </Label>
          {/* CLOSED select — the enforcement point: an author cannot choose or type a sixth primitive. */}
          <Select value={kind.primitive} onValueChange={(next) => patch({ primitive: next as ContextPrimitive })}>
            <SelectTrigger id={`${uid}-primitive`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTEXT_PRIMITIVES.map((primitive) => (
                <SelectItem key={primitive} value={primitive}>
                  {primitive}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">
            Produced by{' '}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </span>
          <div className="flex flex-wrap gap-4" role="group" aria-label="Produced by">
            {CONTEXT_PRODUCERS.map((producer) => {
              const checkboxId = `${uid}-producer-${producer}`;
              return (
                <div key={producer} className="flex items-center gap-2">
                  <Checkbox
                    id={checkboxId}
                    checked={kind.producedBy.includes(producer)}
                    onCheckedChange={(checked) => toggleProducer(producer, checked === true)}
                  />
                  <Label htmlFor={checkboxId} className="font-normal">
                    {producer}
                  </Label>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox id={`${uid}-required`} checked={kind.required === true} onCheckedChange={(checked) => patch({ required: checked === true })} />
        <Label htmlFor={`${uid}-required`} className="font-normal">
          Required — every consultation must carry this kind
        </Label>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-description`}>Description</Label>
        <Textarea
          id={`${uid}-description`}
          value={kind.description ?? ''}
          onChange={(event) => patch({ description: event.target.value || undefined })}
          rows={2}
        />
      </div>

      {canCarryFieldRoles ? (
        <Disclosure
          title="Field roles"
          description="Mark which fields tell HOPE the clinician, the department, the visit type or your own reference id."
        >
          <FieldRoleTable kind={kind} index={index} kinds={allKinds} onChange={onChange} />
        </Disclosure>
      ) : null}

      <Disclosure title="Advanced">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-phi`}>PHI class</Label>
            <Select value={kind.phiClass} onValueChange={(next) => patch({ phiClass: next as ContextPhiClass })}>
              <SelectTrigger id={`${uid}-phi`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTEXT_PHI_CLASSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-cardinality`}>Cardinality</Label>
            <Select value={kind.cardinality} onValueChange={(next) => patch({ cardinality: next as ContextCardinality })}>
              <SelectTrigger id={`${uid}-cardinality`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTEXT_CARDINALITIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-lifecycle`}>Lifecycle</Label>
            <Select value={kind.lifecycle} onValueChange={(next) => patch({ lifecycle: next as ContextLifecycle })}>
              <SelectTrigger id={`${uid}-lifecycle`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTEXT_LIFECYCLES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {kind.primitive === 'STRUCTURED' ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-fields`}>
              Fields (JSON Schema){' '}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <CodeEditor aria-label="Fields JSON Schema" value={fieldsText} onChange={handleFieldsChange} language="json" className="min-h-40" />
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

        <ConstraintsFields kind={kind} onChange={patch} uid={uid} />
        <DeprecationFields kind={kind} onChange={patch} uid={uid} />

        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={onRemove}>
            <IconTrash aria-hidden />
            Remove kind
          </Button>
        </div>
      </Disclosure>
    </div>
  );
}

function ConstraintsFields({
  kind,
  onChange,
  uid,
}: {
  kind: ContextKindDeclaration;
  onChange: (next: Partial<ContextKindDeclaration>) => void;
  uid: string;
}) {
  const mimeTypesText = (kind.constraints?.mimeTypes ?? []).join(', ');

  function setMimeTypes(text: string) {
    const mimeTypes = text
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    onChange({ constraints: { ...kind.constraints, mimeTypes: mimeTypes.length > 0 ? mimeTypes : undefined } });
  }

  function setMaxBytes(text: string) {
    const maxBytes = text.trim() === '' ? undefined : Number(text);
    onChange({ constraints: { ...kind.constraints, maxBytes: Number.isFinite(maxBytes) ? maxBytes : undefined } });
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <span className="text-sm font-medium">Constraints (optional)</span>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-mime-types`}>MIME types (comma-separated)</Label>
          <Input
            id={`${uid}-mime-types`}
            value={mimeTypesText}
            onChange={(event) => setMimeTypes(event.target.value)}
            placeholder="application/pdf, image/png"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-max-bytes`}>Max bytes</Label>
          <Input
            id={`${uid}-max-bytes`}
            type="number"
            min={1}
            inputMode="numeric"
            value={kind.constraints?.maxBytes ?? ''}
            onChange={(event) => setMaxBytes(event.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

function DeprecationFields({
  kind,
  onChange,
  uid,
}: {
  kind: ContextKindDeclaration;
  onChange: (next: Partial<ContextKindDeclaration>) => void;
  uid: string;
}) {
  const deprecated = kind.deprecated;

  function setDeprecated(enabled: boolean) {
    onChange({ deprecated: enabled ? { since: new Date().toISOString().slice(0, 10) } : undefined });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Deprecated</span>
          {deprecated ? <Badge variant="secondary">Deprecated</Badge> : null}
        </div>
        <Switch aria-label="Mark this kind deprecated" checked={!!deprecated} onCheckedChange={setDeprecated} />
      </div>
      {deprecated ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-deprecated-since`}>
              Deprecated since{' '}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <Input
              id={`${uid}-deprecated-since`}
              type="date"
              value={deprecated.since}
              onChange={(event) => onChange({ deprecated: { ...deprecated, since: event.target.value } })}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-deprecated-migrate-by`}>Migrate by</Label>
            <Input
              id={`${uid}-deprecated-migrate-by`}
              type="date"
              value={deprecated.migrateBy ?? ''}
              onChange={(event) => onChange({ deprecated: { ...deprecated, migrateBy: event.target.value || undefined } })}
            />
          </div>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor={`${uid}-deprecated-message`}>Migration guidance</Label>
            <Textarea
              id={`${uid}-deprecated-message`}
              value={deprecated.message ?? ''}
              onChange={(event) => onChange({ deprecated: { ...deprecated, message: event.target.value || undefined } })}
              rows={2}
              maxLength={500}
            />
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Mark this kind deprecated with a migration window instead of deleting it — clients keep working during the window and see the guidance in
          discovery.
        </p>
      )}
    </div>
  );
}
