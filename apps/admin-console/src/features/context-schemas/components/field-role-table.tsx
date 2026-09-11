'use client';

/**
 * "Field roles" table for a single kind (TASK-951 D-1/D-11, replaces the
 * TASK-950 "User identity field" picker, `user-identity-field-select.tsx`).
 *
 * Rendered only for a `STRUCTURED` kind with `cardinality: 'ONE'` — the only
 * shape every role marker below is allowed on. Four roles map a string
 * property to a well-known meaning at consultation `open` — Identity (user),
 * Department (+ how to resolve it: code or name), Visit type (only string
 * properties whose `enum` is a subset of `new-visit`/`revisit`), External
 * ref — and each is capped at one kind per definition, so its `Select`
 * disables itself (with a visible reason) once another kind already carries
 * it. Two more roles are plain booleans: Stream context (marks this kind's
 * payload as the client-owned identity of an audio stream, also capped at
 * one kind) and "Materialise as case notes" (persists this kind's `notes`
 * array as `CASE_NOTE` context items; several kinds may carry it, so it is
 * gated only on the kind's shape actually having a `notes` array of objects
 * with a string `text`, never on "held elsewhere").
 *
 * See `context-schema-definition.ts` (lane B) for the frozen validation this
 * mirrors, and `docs/implementation/TASK-951-.../README.md` D-1..D-12 for the
 * full grammar.
 */

import { useId } from 'react';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import type { ContextKindDeclaration } from '../api/types';

const NONE_VALUE = '__none__';
const VISIT_TYPE_VALUES = ['new-visit', 'revisit'] as const;

type SingleRoleKey = 'userIdentity' | 'department' | 'visitType' | 'externalRef' | 'streamContext';

/** Keys of `fields.properties` whose declared JSON-Schema `type` is `'string'`. */
function stringPropertyKeys(fields: Record<string, unknown> | undefined): string[] {
  const properties = fields && typeof fields === 'object' ? (fields as { properties?: unknown }).properties : undefined;
  if (!properties || typeof properties !== 'object') return [];
  return Object.entries(properties as Record<string, unknown>)
    .filter(([, schema]) => typeof schema === 'object' && schema !== null && (schema as { type?: unknown }).type === 'string')
    .map(([key]) => key);
}

/** String properties whose `enum` is a non-empty subset of `['new-visit', 'revisit']`. */
function eligibleVisitTypeFields(fields: Record<string, unknown> | undefined): string[] {
  const properties = fields && typeof fields === 'object' ? (fields as { properties?: unknown }).properties : undefined;
  if (!properties || typeof properties !== 'object') return [];
  return Object.entries(properties as Record<string, unknown>)
    .filter(([, schema]) => {
      if (typeof schema !== 'object' || schema === null) return false;
      const declared = schema as { type?: unknown; enum?: unknown };
      if (declared.type !== 'string') return false;
      if (!Array.isArray(declared.enum) || declared.enum.length === 0) return false;
      return declared.enum.every((value) => (VISIT_TYPE_VALUES as readonly unknown[]).includes(value));
    })
    .map(([key]) => key);
}

/** Whether `fields.properties.notes` is a JSON Schema array of objects each declaring a string `text`. */
function qualifiesForCaseNotes(fields: Record<string, unknown> | undefined): boolean {
  const properties = fields && typeof fields === 'object' ? (fields as { properties?: unknown }).properties : undefined;
  if (!properties || typeof properties !== 'object') return false;
  const notes = (properties as Record<string, unknown>).notes;
  if (typeof notes !== 'object' || notes === null) return false;
  const notesSchema = notes as { type?: unknown; items?: unknown };
  if (notesSchema.type !== 'array' || typeof notesSchema.items !== 'object' || notesSchema.items === null) return false;
  const itemsSchema = notesSchema.items as { type?: unknown; properties?: unknown };
  if (itemsSchema.type !== 'object' || typeof itemsSchema.properties !== 'object' || itemsSchema.properties === null) return false;
  const text = (itemsSchema.properties as Record<string, unknown>).text;
  return typeof text === 'object' && text !== null && (text as { type?: unknown }).type === 'string';
}

/** The other kind (if any) already carrying `roleKey`, excluding this kind's own position. */
function heldElsewhere(kinds: ContextKindDeclaration[], index: number, roleKey: SingleRoleKey): ContextKindDeclaration | undefined {
  return kinds.find((other, otherIndex) => otherIndex !== index && !!other[roleKey]);
}

function HeldElsewhereHint({ other }: { other: ContextKindDeclaration | undefined }) {
  if (!other) return null;
  return (
    <p className="text-muted-foreground text-xs">
      Held by «{other.key || other.label}»
    </p>
  );
}

export function FieldRoleTable({
  kind,
  index,
  kinds,
  onChange,
}: {
  kind: ContextKindDeclaration;
  /** This kind's position in `kinds` — excluded when checking for a marker elsewhere. */
  index: number;
  /** Every kind in the current draft, to enforce "at most one marker per definition" per role. */
  kinds: ContextKindDeclaration[];
  onChange: (next: ContextKindDeclaration) => void;
}) {
  const uid = useId();

  if (kind.primitive !== 'STRUCTURED' || kind.cardinality !== 'ONE') return null;

  const stringFields = stringPropertyKeys(kind.fields);
  const visitTypeFields = eligibleVisitTypeFields(kind.fields);
  const caseNotesEligible = qualifiesForCaseNotes(kind.fields);

  const identityHeld = heldElsewhere(kinds, index, 'userIdentity');
  const departmentHeld = heldElsewhere(kinds, index, 'department');
  const visitTypeHeld = heldElsewhere(kinds, index, 'visitType');
  const externalRefHeld = heldElsewhere(kinds, index, 'externalRef');
  const streamContextHeld = heldElsewhere(kinds, index, 'streamContext');

  function handleIdentity(next: string) {
    if (next === NONE_VALUE) {
      const { userIdentity: _omit, ...rest } = kind;
      onChange(rest);
      return;
    }
    onChange({ ...kind, userIdentity: { field: next } });
  }

  function handleDepartmentField(next: string) {
    if (next === NONE_VALUE) {
      const { department: _omit, ...rest } = kind;
      onChange(rest);
      return;
    }
    onChange({ ...kind, department: { field: next, by: kind.department?.by ?? 'code' } });
  }

  function handleDepartmentBy(next: string) {
    if (!kind.department) return;
    onChange({ ...kind, department: { ...kind.department, by: next as 'code' | 'name' } });
  }

  function handleVisitType(next: string) {
    if (next === NONE_VALUE) {
      const { visitType: _omit, ...rest } = kind;
      onChange(rest);
      return;
    }
    onChange({ ...kind, visitType: { field: next } });
  }

  function handleExternalRef(next: string) {
    if (next === NONE_VALUE) {
      const { externalRef: _omit, ...rest } = kind;
      onChange(rest);
      return;
    }
    onChange({ ...kind, externalRef: { field: next } });
  }

  function handleStreamContext(checked: boolean) {
    if (!checked) {
      const { streamContext: _omit, ...rest } = kind;
      onChange(rest);
      return;
    }
    onChange({ ...kind, streamContext: true });
  }

  function handleMaterializeAs(checked: boolean) {
    if (!checked) {
      const { materializeAs: _omit, ...rest } = kind;
      onChange(rest);
      return;
    }
    onChange({ ...kind, materializeAs: 'CASE_NOTE' });
  }

  const identityId = `${uid}-identity`;
  const departmentId = `${uid}-department`;
  const departmentByFieldId = `${uid}-department-by`;
  const visitTypeId = `${uid}-visit-type`;
  const externalRefId = `${uid}-external-ref`;
  const streamContextId = `${uid}-stream-context`;
  const materializeAsId = `${uid}-materialize-as`;

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">Field roles</h4>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Role</TableHead>
            <TableHead>Field</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>
              <Label htmlFor={identityId}>Identity (user)</Label>
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <Select value={kind.userIdentity?.field ?? NONE_VALUE} onValueChange={handleIdentity} disabled={!!identityHeld}>
                  <SelectTrigger id={identityId} className="w-full min-w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_VALUE}>None</SelectItem>
                    {stringFields.map((field) => (
                      <SelectItem key={field} value={field}>
                        {field}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <HeldElsewhereHint other={identityHeld} />
              </div>
            </TableCell>
          </TableRow>

          <TableRow>
            <TableCell>
              <Label htmlFor={departmentId}>Department</Label>
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={kind.department?.field ?? NONE_VALUE} onValueChange={handleDepartmentField} disabled={!!departmentHeld}>
                    <SelectTrigger id={departmentId} className="w-full min-w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>None</SelectItem>
                      {stringFields.map((field) => (
                        <SelectItem key={field} value={field}>
                          {field}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Label htmlFor={departmentByFieldId} className="text-muted-foreground text-xs whitespace-nowrap">
                    by
                  </Label>
                  <Select value={kind.department?.by ?? 'code'} onValueChange={handleDepartmentBy} disabled={!!departmentHeld || !kind.department}>
                    <SelectTrigger id={departmentByFieldId} className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="code">code</SelectItem>
                      <SelectItem value="name">name</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <HeldElsewhereHint other={departmentHeld} />
              </div>
            </TableCell>
          </TableRow>

          <TableRow>
            <TableCell>
              <Label htmlFor={visitTypeId}>Visit type</Label>
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <Select value={kind.visitType?.field ?? NONE_VALUE} onValueChange={handleVisitType} disabled={!!visitTypeHeld}>
                  <SelectTrigger id={visitTypeId} className="w-full min-w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_VALUE}>None</SelectItem>
                    {visitTypeFields.map((field) => (
                      <SelectItem key={field} value={field}>
                        {field}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <HeldElsewhereHint other={visitTypeHeld} />
                {!visitTypeHeld && visitTypeFields.length === 0 ? (
                  <p className="text-muted-foreground text-xs">Requires a string field with an enum of “new-visit”/“revisit”.</p>
                ) : null}
              </div>
            </TableCell>
          </TableRow>

          <TableRow>
            <TableCell>
              <Label htmlFor={externalRefId}>External ref</Label>
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <Select value={kind.externalRef?.field ?? NONE_VALUE} onValueChange={handleExternalRef} disabled={!!externalRefHeld}>
                  <SelectTrigger id={externalRefId} className="w-full min-w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_VALUE}>None</SelectItem>
                    {stringFields.map((field) => (
                      <SelectItem key={field} value={field}>
                        {field}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <HeldElsewhereHint other={externalRefHeld} />
              </div>
            </TableCell>
          </TableRow>

          <TableRow>
            <TableCell>
              <Label htmlFor={streamContextId}>Stream context (echoed on transcripts)</Label>
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <Switch
                  id={streamContextId}
                  aria-label="Stream context (echoed on transcripts)"
                  checked={!!kind.streamContext}
                  onCheckedChange={handleStreamContext}
                  disabled={!!streamContextHeld}
                />
                <HeldElsewhereHint other={streamContextHeld} />
              </div>
            </TableCell>
          </TableRow>

          <TableRow>
            <TableCell>
              <Label htmlFor={materializeAsId}>Materialise notes as case notes</Label>
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <Switch
                  id={materializeAsId}
                  aria-label="Materialise notes as case notes"
                  checked={kind.materializeAs === 'CASE_NOTE'}
                  onCheckedChange={handleMaterializeAs}
                  disabled={!caseNotesEligible}
                />
                {!caseNotesEligible ? (
                  <p className="text-muted-foreground text-xs">Requires a “notes” array of objects with a “text” field.</p>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
