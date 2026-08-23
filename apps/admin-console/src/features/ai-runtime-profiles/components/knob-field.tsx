'use client';

import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import type { KnobSpec } from '../api/types';

/**
 * One runtime-profile knob.
 *
 * THE EMPTY STRING IS A MEANING, NOT AN ABSENCE. Every knob is three-state on
 * the wire — a number, `null` ("no opinion", fall through the cascade), or
 * omitted ("leave whatever is stored alone"). This control maps an empty input
 * to `null`, which is why clearing a field is a real, expressible edit rather
 * than a no-op: it hands the knob back to the cascade.
 *
 * The `inherited` line is what stops that from being a guessing game. When the
 * row itself carries no opinion, the resolved cascade still has a value (from
 * the provider-level default row), and showing it — labelled as inherited, not
 * merely greyed — is how an admin can tell "nothing is set here" from "nothing
 * applies here". Colour alone would not carry that (rule 11 §10), so the state
 * is stated in words.
 */
export function KnobField({
  spec,
  value,
  inherited,
  onChange,
  disabled,
  invalid,
  idPrefix,
}: {
  spec: KnobSpec;
  /** Draft text. Empty string = cleared to `null`. */
  value: string;
  /** The resolved value when this row has no opinion of its own; `null` = none anywhere. */
  inherited: number | null;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** Set when the draft is out of the server's declared range. */
  invalid?: string;
  idPrefix: string;
}) {
  const id = `${idPrefix}-${spec.name}`;
  const describedBy = `${id}-help`;
  const errorId = `${id}-error`;
  const cleared = value.trim() === '';
  const range = spec.max === undefined ? `min ${spec.min}` : `${spec.min}–${spec.max}`;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{spec.label}</Label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        placeholder={spec.placeholder}
        inputMode={spec.kind === 'integer' ? 'numeric' : 'decimal'}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={invalid ? `${describedBy} ${errorId}` : describedBy}
        aria-invalid={invalid ? true : undefined}
        className="font-mono"
      />
      <p id={describedBy} className="text-muted-foreground text-xs">
        {spec.description} <span className="font-mono">({range})</span>
        {cleared ? (
          <>
            {' '}
            &mdash;{' '}
            {inherited === null ? (
              <span>no opinion at any level; the service keeps its own default</span>
            ) : (
              <span>
                no opinion here; inherits <span className="font-mono">{inherited}</span> from the provider default
              </span>
            )}
          </>
        ) : null}
      </p>
      {invalid ? (
        <p id={errorId} className="text-destructive text-sm">
          {invalid}
        </p>
      ) : null}
    </div>
  );
}
