'use client';

/**
 * `CelExpressionField` — the Studio's CEL editor (TASK-864 B1) for every `format: 'cel'`
 * string in a core node's config schema (`core.condition.branches[].when`, `core.loop.until`).
 *
 * Deliberately small: a `TemplateEditor` in CEL mode (completion after `trigger.` / `context.` /
 * `nodes.` over the workflow's schema paths and graph references), a client-side FAST-FAIL that
 * only checks what a text box can check without the evaluator (balanced brackets and quotes,
 * non-empty), and quick-insert chips for the run-context references the graph offers — the
 * single-pointer alternative to typing. Type-checking against
 * the context schema stays SERVER-SIDE at publish (`expressionProblems`) — the same posture as
 * the rest of the inspector: the client decides how to RENDER, never whether a value is valid.
 *
 * TASK-1036 R-C #5 — "+ Insert field" opens the composer's four-group picker (`groups`, the
 * condition picker; otherwise one built from the completion paths) and writes the picked field's
 * CEL path at the cursor.
 */
import { Button, Field, FieldError, FieldLabel } from '@arcaai/ui';
import { TemplateEditor, type TemplateEditorHandle, type VariablePath } from '@arcaai/ui/components/custom/template-editor';
import { useId, useMemo, useRef } from 'react';
import { celPathOf } from '../../lib/condition-builder';
import type { PickerGroup } from '../../lib/picker-model';
import { FieldCopy } from './field-copy';
import { InsertFieldButton, groupsFromPaths } from './insert-field-button';

export interface CelExpressionFieldProps {
  id: string;
  label: string;
  /** TASK-893 B3 — plain-language copy shown inline; falls back to a truncated `description`. */
  summary?: string;
  description?: string;
  required?: boolean;
  value: string;
  onChange: (next: string) => void;
  /** Server findings for this path, verbatim. */
  errors?: string[];
  /** Run-context references the graph offers (computed by the inspector from the graph). */
  references?: readonly string[];
  /** The workflow's schema paths (`trigger.*` / `context.*`), offered as completions. */
  paths?: readonly VariablePath[];
  /** TASK-1036 R-C #5 — the composer's condition picker groups; absent = built from `paths` + `references`. */
  groups?: readonly PickerGroup[];
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

const NO_PATHS: readonly VariablePath[] = [];
const NO_REFERENCES: readonly string[] = [];

export function CelExpressionField({
  id,
  label,
  summary,
  description,
  required,
  value,
  onChange,
  errors,
  references = NO_REFERENCES,
  paths = NO_PATHS,
  groups,
  disabled,
}: CelExpressionFieldProps) {
  const hintId = useId();
  const editorRef = useRef<TemplateEditorHandle>(null);
  const labelId = `${id}-label`;
  const completionPaths = useMemo(
    () => [...paths, ...references.map((path) => ({ path, type: 'reference', required: false, phiClass: null, description: null, deprecated: false }))],
    [paths, references],
  );
  const pickerGroups = useMemo(() => groups ?? groupsFromPaths(completionPaths), [groups, completionPaths]);
  const syntax = celSyntaxProblem(value);
  const allErrors = [...(syntax ? [syntax] : []), ...(errors ?? [])];
  return (
    <Field data-invalid={allErrors.length > 0 ? 'true' : undefined}>
      <FieldLabel id={labelId}>
        {label}
        {required ? ' *' : ''}
      </FieldLabel>
      <FieldCopy label={label} summary={summary} description={description} />
      <TemplateEditor
        id={id}
        mode="cel"
        value={value}
        onChange={onChange}
        paths={completionPaths}
        minLines={2}
        readOnly={disabled}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        aria-invalid={allErrors.length > 0}
        editorRef={editorRef}
      />
      {pickerGroups.length > 0 ? (
        <InsertFieldButton groups={pickerGroups} fieldName={label} disabled={disabled} onPick={(item) => editorRef.current?.insertAtCursor(celPathOf(item.raw))} />
      ) : null}
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
