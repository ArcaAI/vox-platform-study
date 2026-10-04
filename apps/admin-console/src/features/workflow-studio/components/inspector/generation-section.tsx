'use client';

/**
 * TASK-1036 W2 / §8.6 — generation, the friendly way: temperature and max output tokens ONLY,
 * and only when the agent's model supports them (`tenantEditableParams`; a reasoning model takes
 * no temperature). Written as this node's overrides (`overrides.generation.*`); every other knob
 * is platform-managed and never rendered here.
 */
import { Field, FieldDescription, FieldLabel, Input } from '@arcaai/ui';
import type { ModelCapabilities } from '@arcaai/workflow-contract';
import { generationFields } from '../../lib/generation-model';
import { getAtPath, setAtPath } from './field-path';

export interface GenerationSectionProps {
  idPrefix: string;
  task: string | null | undefined;
  capabilities: ModelCapabilities | null | undefined;
  modelName?: string | null;
  config: Record<string, unknown>;
  onConfigChange: (config: Record<string, unknown>) => void;
  disabled?: boolean;
  errorsFor?: (path: string) => string[];
}

function withoutPath(config: Record<string, unknown>, path: string): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return config;
  const current = config[head];
  if (rest.length === 0) {
    const { [head]: _drop, ...others } = config;
    return others;
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) return config;
  const inner = withoutPath(current as Record<string, unknown>, rest.join('.'));
  const { [head]: _drop, ...others } = config;
  return Object.keys(inner).length > 0 ? { ...others, [head]: inner } : others;
}

export function GenerationSection({ idPrefix, task, capabilities, modelName, config, onConfigChange, disabled, errorsFor }: GenerationSectionProps) {
  if (task !== 'TEXT_GENERATION') return null;
  const fields = generationFields(task, capabilities);
  return (
    <section aria-labelledby={`${idPrefix}-generation-heading`} className="flex flex-col gap-3" data-slot="generation-section">
      <h3 id={`${idPrefix}-generation-heading`} className="text-sm font-medium">
        Generation
      </h3>
      {fields.map((field) => {
        const id = `${idPrefix}-${field.key}`;
        const value = getAtPath(config, field.path);
        const errors = errorsFor?.(field.path) ?? [];
        return (
          <Field key={field.key} data-invalid={errors.length > 0 ? 'true' : undefined}>
            <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
            <Input
              id={id}
              type="number"
              inputMode="decimal"
              min={field.min}
              max={field.max}
              step={field.step}
              value={typeof value === 'number' ? String(value) : ''}
              placeholder="Agent default"
              disabled={disabled}
              onChange={(event) => {
                const raw = event.target.value;
                const parsed = Number(raw);
                onConfigChange(raw === '' || !Number.isFinite(parsed) ? withoutPath(config, field.path) : setAtPath(config, field.path, parsed));
              }}
            />
            <FieldDescription>{field.description} Empty uses the agent’s own value.</FieldDescription>
            {errors.map((message) => (
              <p key={message} className="text-destructive text-sm">
                {message}
              </p>
            ))}
          </Field>
        );
      })}
      <p className="text-muted-foreground text-xs">
        {fields.length === 0
          ? 'This model’s generation is tuned by the platform.'
          : `Shown because ${modelName ?? 'this model'} supports ${fields.length === 2 ? 'both' : 'it'}. Everything else is tuned by the platform.`}
      </p>
    </section>
  );
}
