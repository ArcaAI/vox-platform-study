'use client';

/**
 * The `raw-json` degradation ( / lib/schema-form.ts) — rule 11 forbids editing
 * JSON in a bare `<Textarea>`, so this is `CodeEditor` (`@arcaai/ui`), never a hand-rolled one.
 * Used both for a genuinely unrepresentable schema SUBTREE and — the common case against the
 * real, delivered registry today — a node type with NO config schema at all
 * (`contracts/registry.contract.md`).
 */
import { useState } from 'react';
import { CodeEditor, Field, FieldDescription, FieldError, FieldLabel } from '@arcaai/ui';
import type { RawJsonFieldDescriptor } from '../../lib/schema-form';

export interface RawJsonFieldProps {
  descriptor: RawJsonFieldDescriptor;
  value: unknown;
  onChange: (next: unknown) => void;
  id: string;
  errors?: string[];
}

export function RawJsonField({ descriptor, value, onChange, id, errors }: RawJsonFieldProps) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));

  return (
    <Field data-invalid={(errors?.length ?? 0) > 0 ? 'true' : undefined}>
      <FieldLabel htmlFor={id}>
        {descriptor.label}
        {descriptor.required ? ' *' : ''}
      </FieldLabel>
      <FieldDescription>{descriptor.reason}</FieldDescription>
      <CodeEditor
        aria-label={descriptor.label}
        value={text}
        onChange={(next) => {
          setText(next);
          try {
            onChange(JSON.parse(next));
          } catch {
            // Invalid JSON mid-edit is expected while typing — CodeEditor's own toolbar
            // surfaces the parse error; we simply don't propagate an unparsable value up.
          }
        }}
      />
      <FieldError errors={errors?.map((message) => ({ message }))} />
    </Field>
  );
}

/** The whole-panel fallback when the node type carries no config schema at all — distinct copy
 *  from the per-subtree `raw-json` descriptor's reason so an author understands WHY they only
 *  ever see raw JSON for this node type. */
export const NO_SCHEMA_REASON = 'This node type has no configuration schema yet — edit its config as JSON.';
