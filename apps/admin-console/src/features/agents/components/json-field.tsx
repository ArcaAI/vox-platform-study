'use client';

import { useId, useState } from 'react';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';

/**
 * A JSON object field with live validation and a visible label. Empty ⇒ `null` (the agent
 * falls back to the task default). Kept in one file so it can be swapped for `CodeEditor`
 * without touching its callers.
 */
export function JsonField({
  label,
  description,
  value,
  onChange,
  rows = 8,
  placeholder,
}: {
  label: string;
  description?: string;
  value: Record<string, unknown> | null;
  onChange: (value: Record<string, unknown> | null) => void;
  rows?: number;
  placeholder?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : '');
  const [error, setError] = useState<string | null>(null);

  function handleChange(next: string) {
    setText(next);
    if (next.trim() === '') {
      setError(null);
      onChange(null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(next);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('Must be a JSON object.');
        return;
      }
      setError(null);
      onChange(parsed as Record<string, unknown>);
    } catch {
      setError('Invalid JSON.');
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {description ? (
        <p id={`${id}-desc`} className="text-muted-foreground text-xs">
          {description}
        </p>
      ) : null}
      <Textarea
        id={id}
        value={text}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        className="font-mono text-xs"
        aria-describedby={description ? `${id}-desc` : undefined}
        aria-invalid={error ? true : undefined}
        onChange={(event) => handleChange(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
