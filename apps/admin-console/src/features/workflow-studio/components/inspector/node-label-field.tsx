'use client';

/**
 * TASK-1036 OD-20 — a step's NAME. References are shown by label and stored by node id, so a
 * rename never breaks a binding. Committed on blur / Enter (one undo step per rename, not one per
 * keystroke); capped at `NODE_LABEL_MAX_LENGTH`.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { IconCopy } from '@tabler/icons-react';
import { Button, Field, FieldDescription, FieldLabel, Input } from '@arcaai/ui';
import { NODE_LABEL_MAX_LENGTH } from '@arcaai/workflow-contract';

export interface NodeLabelFieldProps {
  idPrefix: string;
  value: string;
  /** What the step is called when unnamed (the agent's name, or the step type in words). */
  placeholder: string;
  /**
   * The step's stored id, shown as a muted, copyable detail (owner, 2026-10-05: the id never
   * appears in a step's NAME; this is the one place it is visible, for support and bindings).
   */
  nodeId?: string;
  onChange: (label: string) => void;
  disabled?: boolean;
}

export function NodeLabelField({ idPrefix, value, placeholder, nodeId, onChange, disabled }: NodeLabelFieldProps) {
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
      {nodeId ? (
        <p className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs" data-slot="node-id">
          <span>ID</span>
          <code className="min-w-0 truncate font-mono" title={nodeId}>
            {nodeId}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6 shrink-0"
            aria-label={`Copy step ID ${nodeId}`}
            title="Copy step ID"
            onClick={() => {
              const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
              if (!clipboard) {
                toast.error('Copy is not available in this browser.');
                return;
              }
              clipboard.writeText(nodeId).then(
                () => toast.success('Step ID copied.'),
                () => toast.error('Could not copy the step ID.'),
              );
            }}
          >
            <IconCopy aria-hidden="true" />
          </Button>
        </p>
      ) : null}
    </Field>
  );
}
