'use client';

/**
 * One `FieldDescriptor` (`lib/schema-form.ts`) -> a `Field` family control.
 * Controlled state only — no `react-hook-form` ( Rule 11: labels always
 * visible, required marked `*`, errors below the field in `text-destructive text-sm`
 * (`FieldError` already carries that class).
 */
import {
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@arcaai/ui';
import type { FieldDescriptor } from '../../lib/schema-form';
import { CelExpressionField } from './cel-expression-field';
import { FieldCopy, summaryOf } from './field-copy';
import { getAtPath, setAtPath } from './field-path';
import { RawJsonField } from './raw-json-field';

/** One field's render context, handed to a `fieldOverrides` entry — everything a specialized
 *  control needs and nothing it would otherwise have to re-derive. */
export interface FieldRenderContext {
  value: unknown;
  set: (next: unknown) => void;
  errors?: string[];
  id: string;
}

export interface FieldRendererProps {
  descriptor: FieldDescriptor;
  config: Record<string, unknown>;
  onConfigChange: (config: Record<string, unknown>) => void;
  /** Server `WorkflowFinding.message` strings whose `path` matches this descriptor, verbatim. */
  errors?: string[];
  idPrefix: string;
  /** Run-context references the CEL editor offers as quick inserts (TASK-864 B1). */
  references?: readonly string[];
  /**
   * TASK-890 §3.10 — a per-PATH escape hatch for a field NESTED inside a schema `group` (e.g.
   * `overrides.promptVariables`, buried inside `core.agent`'s `overrides` object). The top-level
   * withholding `Set` in `inspector-panel.tsx` only reaches TOP-LEVEL descriptor paths; a field
   * one or more groups deep needs this instead — checked before `descriptor.kind` is dispatched
   * on, so it can replace ANY kind (raw-json, string, …), and threaded through every recursive
   * call so it reaches a field at any depth.
   */
  fieldOverrides?: Record<string, (ctx: FieldRenderContext) => React.ReactNode>;
  /**
   * TASK-949 D-8 — resolve a NESTED field's own findings.
   *
   * `errors` above is this descriptor's messages, resolved by the caller. That works for a
   * top-level field and for nothing else: the `group` / `discriminated` branches recurse, and a
   * child's messages are not the parent's, so a nested field used to receive none at all — an
   * `OVERRIDE_OUT_OF_RANGE` on `overrides.generation.temperature` was simply invisible. Passing
   * the LOOKUP down instead of a resolved array lets every level resolve its own path, at any
   * depth. `errors`, when given, still wins — the specialized call sites keep their behaviour.
   */
  errorsFor?: (path: string) => string[];
}

function fieldId(idPrefix: string, path: string): string {
  return `${idPrefix}-${path || 'root'}`;
}

export function FieldRenderer({ descriptor, config, onConfigChange, errors: ownErrors, errorsFor, idPrefix, references, fieldOverrides }: FieldRendererProps) {
  const id = fieldId(idPrefix, descriptor.path);
  const value = getAtPath(config, descriptor.path);
  const set = (next: unknown) => onConfigChange(setAtPath(config, descriptor.path, next));
  // TASK-949 D-8 — an explicitly-passed array wins; otherwise resolve this descriptor's own path.
  const errors = ownErrors ?? errorsFor?.(descriptor.path);

  const override = fieldOverrides?.[descriptor.path];
  if (override) {
    return <>{override({ value, set, errors, id })}</>;
  }

  if (descriptor.kind === 'group') {
    return (
      <FieldSet data-invalid={(errors?.length ?? 0) > 0 ? 'true' : undefined}>
        <FieldLegend variant="label">
          {descriptor.label}
          {descriptor.required ? ' *' : ''}
        </FieldLegend>
        <FieldCopy label={descriptor.label} summary={summaryOf(descriptor)} description={descriptor.description} />
        <div className="flex flex-col gap-4 pl-4">
          {descriptor.fields.map((field) => (
            <FieldRenderer key={field.path} descriptor={field} config={config} onConfigChange={onConfigChange} idPrefix={idPrefix} references={references} fieldOverrides={fieldOverrides} errorsFor={errorsFor} />
          ))}
        </div>
        <FieldError errors={errors?.map((message) => ({ message }))} />
      </FieldSet>
    );
  }

  if (descriptor.kind === 'discriminated') {
    const branchValue = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[descriptor.discriminatorProperty] : undefined;
    const currentBranch = descriptor.branches.find((branch) => branch.value === branchValue) ?? descriptor.branches[0];
    const branchDescriptorId = fieldId(idPrefix, `${descriptor.path}.${descriptor.discriminatorProperty}`);
    return (
      <FieldSet data-invalid={(errors?.length ?? 0) > 0 ? 'true' : undefined}>
        <FieldLegend variant="label">
          {descriptor.label}
          {descriptor.required ? ' *' : ''}
        </FieldLegend>
        <FieldCopy label={descriptor.label} summary={summaryOf(descriptor)} description={descriptor.description} />
        <Field>
          <FieldLabel htmlFor={branchDescriptorId}>{descriptor.discriminatorProperty}</FieldLabel>
          <Select value={currentBranch?.value ?? ''} onValueChange={(next) => set({ [descriptor.discriminatorProperty]: next })}>
            <SelectTrigger id={branchDescriptorId}>
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {descriptor.branches.map((branch) => (
                <SelectItem key={branch.value} value={branch.value}>
                  {branch.value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {currentBranch ? (
          <div className="flex flex-col gap-4 pl-4">
            {currentBranch.fields.map((field) => (
              <FieldRenderer key={field.path} descriptor={field} config={config} onConfigChange={onConfigChange} idPrefix={idPrefix} references={references} fieldOverrides={fieldOverrides} errorsFor={errorsFor} />
            ))}
          </div>
        ) : null}
        <FieldError errors={errors?.map((message) => ({ message }))} />
      </FieldSet>
    );
  }

  if (descriptor.kind === 'raw-json') {
    return <RawJsonField descriptor={descriptor} value={value} onChange={set} id={id} errors={errors} />;
  }

  if (descriptor.kind === 'enum') {
    return (
      <Field data-invalid={(errors?.length ?? 0) > 0 ? 'true' : undefined}>
        <FieldLabel htmlFor={id}>
          {descriptor.label}
          {descriptor.required ? ' *' : ''}
        </FieldLabel>
        <FieldCopy label={descriptor.label} summary={summaryOf(descriptor)} description={descriptor.description} />
        <Select value={typeof value === 'string' ? value : descriptor.default} onValueChange={(next) => set(next)}>
          <SelectTrigger id={id}>
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {descriptor.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError errors={errors?.map((message) => ({ message }))} />
      </Field>
    );
  }

  if (descriptor.kind === 'boolean') {
    const checked = typeof value === 'boolean' ? value : (descriptor.default ?? false);
    return (
      <Field orientation="horizontal" data-invalid={(errors?.length ?? 0) > 0 ? 'true' : undefined}>
        <FieldContent>
          <FieldLabel htmlFor={id}>
            {descriptor.label}
            {descriptor.required ? ' *' : ''}
          </FieldLabel>
          <FieldCopy label={descriptor.label} summary={summaryOf(descriptor)} description={descriptor.description} />
        </FieldContent>
        <Switch id={id} checked={checked} onCheckedChange={(next) => set(next)} />
        <FieldError errors={errors?.map((message) => ({ message }))} />
      </Field>
    );
  }

  if (descriptor.kind === 'number') {
    const numeric = typeof value === 'number' ? value : descriptor.default;
    return (
      <Field data-invalid={(errors?.length ?? 0) > 0 ? 'true' : undefined}>
        <FieldLabel htmlFor={id}>
          {descriptor.label}
          {descriptor.required ? ' *' : ''}
        </FieldLabel>
        <FieldCopy label={descriptor.label} summary={summaryOf(descriptor)} description={descriptor.description} />
        <Input
          id={id}
          type="number"
          min={descriptor.min}
          max={descriptor.max}
          step={descriptor.step}
          value={numeric ?? ''}
          onChange={(event) => {
            const raw = event.target.value;
            set(raw === '' ? undefined : descriptor.integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw));
          }}
        />
        <FieldError errors={errors?.map((message) => ({ message }))} />
      </Field>
    );
  }

  if (descriptor.kind === 'tags') {
    const tags = Array.isArray(value) ? (value as string[]) : [];
    return (
      <Field data-invalid={(errors?.length ?? 0) > 0 ? 'true' : undefined}>
        <FieldLabel htmlFor={id}>
          {descriptor.label}
          {descriptor.required ? ' *' : ''}
        </FieldLabel>
        <FieldCopy label={descriptor.label} summary={summaryOf(descriptor)} description={descriptor.description} />
        <p className="text-muted-foreground text-xs">Comma-separated values.</p>
        <Input
          id={id}
          value={tags.join(', ')}
          onChange={(event) =>
            set(
              event.target.value
                .split(',')
                .map((tag) => tag.trim())
                .filter((tag) => tag.length > 0),
            )
          }
        />
        <FieldError errors={errors?.map((message) => ({ message }))} />
      </Field>
    );
  }

  // 'string' — a `format: 'cel'` string (the contract's CEL_EXPRESSION_PROPERTY) gets the
  // expression editor (TASK-864 B1); every other string is a plain input.
  if (descriptor.format === 'cel') {
    return (
      <CelExpressionField
        id={id}
        label={descriptor.label}
        summary={summaryOf(descriptor)}
        description={descriptor.description}
        required={descriptor.required}
        value={typeof value === 'string' ? value : ''}
        onChange={set}
        errors={errors}
        references={references}
      />
    );
  }
  return (
    <Field data-invalid={(errors?.length ?? 0) > 0 ? 'true' : undefined}>
      <FieldLabel htmlFor={id}>
        {descriptor.label}
        {descriptor.required ? ' *' : ''}
      </FieldLabel>
      <FieldCopy label={descriptor.label} summary={summaryOf(descriptor)} description={descriptor.description} />
      <Input
        id={id}
        value={typeof value === 'string' ? value : (descriptor.default ?? '')}
        maxLength={descriptor.maxLength}
        onChange={(event) => set(event.target.value)}
      />
      <FieldError errors={errors?.map((message) => ({ message }))} />
    </Field>
  );
}
