'use client';

/**
 * `CelExpressionField` — the Studio's CEL editor (TASK-864 B1) for every `format: 'cel'`
 * string in a core node's config schema (`core.condition.branches[].when`, `core.loop.until`).
 *
 * Deliberately small: a monospace textarea (never placeholder-only — the label is visible), a
 * client-side FAST-FAIL that only checks what a text box can check without the evaluator
 * (balanced brackets and quotes, non-empty), and quick-insert chips for the run-context
 * references the graph offers (`trigger`, `vars.<key>`, `nodes.<id>`). Type-checking against
 * the context schema stays SERVER-SIDE at publish (`expressionProblems`) — the same posture as
 * the rest of the inspector: the client decides how to RENDER, never whether a value is valid.
 */
import { Button, Field, FieldDescription, FieldError, FieldLabel, Textarea } from '@arcaai/ui';
import { useId } from 'react';

export interface CelExpressionFieldProps {
  id: string;
  label: string;
  description?: string;
  required?: boolean;
  value: string;
  onChange: (next: string) => void;
  /** Server findings for this path, verbatim. */
  errors?: string[];
  /** Run-context references the graph offers (computed by the inspector from the graph). */
  references?: readonly string[];
  disabled?: boolean;
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set(Object.values(OPENERS));

/** The one syntactic check a text box can make honestly: brackets and quotes balance. */
export function celSyntaxProblem(expression: string): string | null {
  if (expression.trim().length === 0) return null;
  const stack: string[] = [];
  let quote: string | null = null;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (OPENERS[char]) stack.push(OPENERS[char]);
    else if (CLOSERS.has(char)) {
      if (stack.pop() !== char) return `Unexpected "${char}" at position ${index + 1}.`;
    }
  }
  if (quote) return 'Unterminated string literal.';
  if (stack.length > 0) return `Missing closing "${stack[stack.length - 1]}".`;
  return null;
}

export function CelExpressionField({ id, label, description, required, value, onChange, errors, references = [], disabled }: CelExpressionFieldProps) {
  const hintId = useId();
  const syntax = celSyntaxProblem(value);
  const allErrors = [...(syntax ? [syntax] : []), ...(errors ?? [])];
  return (
    <Field data-invalid={allErrors.length > 0 ? 'true' : undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {required ? ' *' : ''}
      </FieldLabel>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <Textarea
        id={id}
        value={value}
        rows={3}
        spellCheck={false}
        disabled={disabled}
        aria-describedby={hintId}
        className="resize-none font-mono text-xs"
        onChange={(event) => onChange(event.target.value)}
      />
      <span id={hintId} className="text-muted-foreground text-xs">
        CEL over the run context — <code className="font-mono">trigger.*</code>, <code className="font-mono">vars.*</code>, <code className="font-mono">nodes.&lt;id&gt;.*</code>.
      </span>
      {references.length > 0 ? (
        <div className="flex flex-wrap gap-1" aria-label="Insert a reference">
          {references.map((reference) => (
            <Button
              key={reference}
              type="button"
              variant="secondary"
              size="xs"
              className="font-mono"
              disabled={disabled}
              onClick={() => onChange(value.length === 0 || /\s$/.test(value) ? `${value}${reference}` : `${value} ${reference}`)}
            >
              {reference}
            </Button>
          ))}
        </div>
      ) : null}
      <FieldError errors={allErrors.map((message) => ({ message }))} />
    </Field>
  );
}
