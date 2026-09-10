'use client';

/**
 * "User identity field" picker for a single kind (TASK-950, D-1/D-12a).
 *
 * Rendered only for a `STRUCTURED` kind with `cardinality: 'ONE'` — the only
 * shape the marker is allowed on. Options are that kind's `fields.properties`
 * keys whose `type` is `'string'`, plus "None". At most one kind in the whole
 * definition may carry the marker, so the select disables itself (with a
 * visible reason) once another kind already does.
 */

import { useId } from 'react';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import type { ContextKindDeclaration } from '../api/types';

const NONE_VALUE = '__none__';

/** Keys of `fields.properties` whose declared JSON-Schema `type` is `'string'`. */
function stringPropertyKeys(fields: Record<string, unknown> | undefined): string[] {
  const properties = fields && typeof fields === 'object' ? (fields as { properties?: unknown }).properties : undefined;
  if (!properties || typeof properties !== 'object') return [];
  return Object.entries(properties as Record<string, unknown>)
    .filter(([, schema]) => typeof schema === 'object' && schema !== null && (schema as { type?: unknown }).type === 'string')
    .map(([key]) => key);
}

export function UserIdentityFieldSelect({
  kind,
  index,
  kinds,
  onChange,
}: {
  kind: ContextKindDeclaration;
  /** This kind's position in `kinds` — excluded when checking for a marker elsewhere. */
  index: number;
  /** Every kind in the current draft, to enforce "at most one marker per definition". */
  kinds: ContextKindDeclaration[];
  onChange: (next: ContextKindDeclaration) => void;
}) {
  const uid = useId();

  if (kind.primitive !== 'STRUCTURED' || kind.cardinality !== 'ONE') return null;

  const stringFields = stringPropertyKeys(kind.fields);
  const markedElsewhere = kinds.find((other, otherIndex) => otherIndex !== index && !!other.userIdentity);
  const disabled = !!markedElsewhere;
  const value = kind.userIdentity?.field ?? NONE_VALUE;

  function handleChange(next: string) {
    if (next === NONE_VALUE) {
      // Delete the key outright — never leave `userIdentity: undefined`/`null` in the draft.
      const { userIdentity: _omit, ...rest } = kind;
      onChange(rest);
      return;
    }
    onChange({ ...kind, userIdentity: { field: next } });
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${uid}-user-identity`}>User identity field</Label>
      <Select value={value} onValueChange={handleChange} disabled={disabled}>
        <SelectTrigger id={`${uid}-user-identity`} className="w-full">
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
      <p className="text-muted-foreground text-xs">
        Maps to the clinician&rsquo;s Staff ID; integrations that send this field act as that user.
      </p>
      {disabled ? (
        <p className="text-muted-foreground text-xs">
          Only one identity field per schema — currently on <span className="font-mono">{markedElsewhere?.key || markedElsewhere?.label}</span>.
        </p>
      ) : null}
    </div>
  );
}
