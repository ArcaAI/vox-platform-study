'use client';

/**
 * One labelled `TemplateEditor` with the server's findings for the same path rendered under it —
 * the field a publish finding names is the field that shows it, not only the Overview tab.
 * The label is wired with `aria-labelledby` (a contenteditable is not a `<label for>` target).
 */
import { useId } from 'react';
import { TemplateEditor, type TemplateDiagnostic, type TemplateEditorMode, type VariablePath } from '@arcaai/ui/components/custom/template-editor';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import type { FieldFinding } from './template-lint';

export interface TemplateFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  paths?: readonly VariablePath[];
  lint?: (content: string) => readonly TemplateDiagnostic[];
  mode?: TemplateEditorMode;
  required?: boolean;
  description?: string;
  findings?: readonly FieldFinding[];
  minLines?: number;
  disabled?: boolean;
  placeholder?: string;
  /** Visually hide the label (it still names the editor) — for compact rows that label elsewhere. */
  hideLabel?: boolean;
}

export function TemplateField({
  label,
  value,
  onChange,
  paths,
  lint,
  mode = 'template',
  required,
  description,
  findings = [],
  minLines,
  disabled,
  placeholder,
  hideLabel,
}: TemplateFieldProps) {
  const labelId = useId();
  const descriptionId = useId();
  const findingsId = useId();
  const describedBy = [description ? descriptionId : null, findings.length > 0 ? findingsId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div data-slot="template-field" className="flex min-w-0 flex-col gap-1.5">
      <span id={labelId} className={hideLabel ? 'sr-only' : 'text-sm font-medium'}>
        {label}
        {required ? <span aria-hidden> *</span> : null}
      </span>
      {description ? (
        <p id={descriptionId} className="text-muted-foreground text-xs">
          {description}
        </p>
      ) : null}
      <TemplateEditor
        value={value}
        onChange={onChange}
        paths={paths}
        lint={lint}
        mode={mode}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={findings.some((finding) => finding.severity === 'ERROR')}
        readOnly={disabled}
        minLines={minLines ?? (mode === 'cel' ? 1 : 6)}
        placeholder={placeholder}
      />
      {findings.length > 0 ? (
        <ul id={findingsId} aria-label={`Publish findings for ${label}`} className="flex flex-col gap-1">
          {findings.map((finding, index) => (
            <li key={`${finding.code}-${index}`} className="flex items-start gap-2 text-xs">
              <Badge variant={finding.severity === 'ERROR' ? 'destructive' : 'secondary'}>{finding.code}</Badge>
              <span className={finding.severity === 'ERROR' ? 'text-destructive' : 'text-muted-foreground'}>{finding.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
