'use client';

/**
 * `PromptTemplatePicker` — the Studio's node inspector gets a *picker* of the
 * tenant's prompt templates, never its own editor: design.md "prompt templates keep their own
 * authoritative editor (picker + deep link)" and rule 13 §Routing's one-authoritative-editor
 * rule. Reads `admin/prompt-templates` through this feature's own `api/hooks.ts`
 * (`usePromptTemplateOptions`) — deliberately NOT imported from `features/departments/**`, which
 * does the identical read for the same "prompt config" reason at
 * `features/departments/api/client.ts:54` (rule 13 §Structure: "features never import each
 * other").
 *
 * Rendered by `field-renderers.tsx` in place of a plain text `Input` for any `string` field whose
 * path is (or ends in) `promptTemplateId` — the naming convention the delivered
 * `WorkflowFinding`/inspector-panel test fixture already uses — and, as a general helper,
 * alongside the raw-JSON fallback for node types the registry has no config schema for yet
 * (the common case today — `contracts/registry.contract.md`).
 */
import Link from 'next/link';
import { IconExternalLink } from '@tabler/icons-react';
import { Field, FieldDescription, FieldError, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@arcaai/ui';
import { usePromptTemplateOptions } from '../../api/hooks';

/** Radix `Select` reserves the empty string for "no value" — route "no template" through a
 *  sentinel, same convention as `department-prompt-config-panel.tsx`'s `NONE_SENTINEL`. */
const NONE_SENTINEL = '__none__';

export interface PromptTemplatePickerProps {
  id: string;
  label: string;
  description?: string;
  value: string;
  onChange: (next: string) => void;
  required?: boolean;
  disabled?: boolean;
  errors?: string[];
}

export function PromptTemplatePicker({ id, label, description, value, onChange, required, disabled, errors }: PromptTemplatePickerProps) {
  const options = usePromptTemplateOptions();

  return (
    <Field data-invalid={(errors?.length ?? 0) > 0 ? 'true' : undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {required ? ' *' : ''}
      </FieldLabel>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {options.isLoading ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <Select value={value || NONE_SENTINEL} onValueChange={(next) => onChange(next === NONE_SENTINEL ? '' : next)} disabled={disabled}>
          <SelectTrigger id={id}>
            <SelectValue placeholder="Select a prompt template…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_SENTINEL}>— None —</SelectItem>
            {(options.data ?? []).map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Link href="/prompt-templates" className="text-foreground inline-flex w-fit items-center gap-1 text-xs hover:underline">
        <IconExternalLink aria-hidden className="size-3" />
        Manage prompt templates
      </Link>
      <FieldError errors={errors?.map((message) => ({ message }))} />
    </Field>
  );
}
