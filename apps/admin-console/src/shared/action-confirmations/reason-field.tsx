'use client';

import { useId } from 'react';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { useActionConfirmation } from './use-action-confirmation';

export interface ReasonFieldProps {
  /** Catalogue action id, e.g. `promptTemplate.update`. */
  actionId: string;
  value: string;
  onChange: (value: string) => void;
  /** Evaluates `when-risky` rows. */
  risky?: boolean;
  /** Visible label; defaults to "Reason" (or "Evidence reference" for an evidence row). */
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Hide the field entirely when the policy does not require it (default: show it as optional). */
  hideWhenOptional?: boolean;
  id?: string;
}

/**
 * The one console-wide reason / evidence field (TASK-1057). It reads the platform policy for its
 * action: required → `*` marker, `aria-required`, and the min-length hint; otherwise it is offered
 * as optional ("(optional)") so an admin can still leave an audit note.
 */
export function ReasonField({ actionId, value, onChange, risky, label, placeholder, disabled, hideWhenOptional, id }: ReasonFieldProps) {
  const policy = useActionConfirmation(actionId);
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = `${fieldId}-hint`;
  const required = policy.isRequired(risky);
  if (!required && hideWhenOptional) return null;
  const noun = label ?? (actionId === 'consent.record' ? 'Evidence reference' : 'Reason');
  const trimmed = value.trim().length;
  const short = required && policy.minLength !== undefined && trimmed > 0 && trimmed < policy.minLength;

  return (
    <div className="flex flex-col gap-2" data-slot="reason-field" data-required={required ? 'true' : 'false'}>
      <Label htmlFor={fieldId}>
        {noun}
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            {' '}
            *
          </span>
        ) : (
          <span className="text-muted-foreground font-normal"> (optional)</span>
        )}
      </Label>
      <Textarea
        id={fieldId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-required={required}
        aria-describedby={hintId}
        aria-invalid={short || undefined}
        {...(policy.maxLength === undefined ? {} : { maxLength: policy.maxLength })}
        className="min-h-20 resize-none"
      />
      <p id={hintId} className={short ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
        {required
          ? policy.minLength !== undefined
            ? `Required — at least ${policy.minLength} characters. Recorded in the audit log.`
            : 'Required. Recorded in the audit log.'
          : 'Recorded in the audit log when given.'}
      </p>
    </div>
  );
}
