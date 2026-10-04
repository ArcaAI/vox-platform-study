'use client';

/**
 * TASK-1036 OD-20 — a step's NAME. References are shown by label and stored by node id, so a
 * rename never breaks a binding. Committed on blur / Enter (one undo step per rename, not one per
 * keystroke); capped at `NODE_LABEL_MAX_LENGTH`.
 */
import { useState } from 'react';
import { Field, FieldDescription, FieldLabel, Input } from '@arcaai/ui';
import { NODE_LABEL_MAX_LENGTH } from '@arcaai/workflow-contract';

export interface NodeLabelFieldProps {
  idPrefix: string;
  value: string;
  /** What the step is called when unnamed (its type and short id). */
  placeholder: string;
  onChange: (label: string) => void;
  disabled?: boolean;
}

export function NodeLabelField({ idPrefix, value, placeholder, onChange, disabled }: NodeLabelFieldProps) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  const id = `${idPrefix}-label`;
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onChange(next);
  };
  return (
    <Field>
      <FieldLabel htmlFor={id}>Step name</FieldLabel>
      <Input
        id={id}
        value={draft}
        maxLength={NODE_LABEL_MAX_LENGTH}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
      <FieldDescription>Shown wherever this step is used. References are stored by id, so renaming a step never breaks one.</FieldDescription>
    </Field>
  );
}
