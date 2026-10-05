'use client';

/**
 * TASK-947 — the "follow the template's own approved version, or pin one" radio pair, extracted
 * out of `InstructionBindingForm` (TASK-890 §3.6) so `FragmentListEditor` can offer the SAME
 * per-fragment version pin without a second, drifting implementation. Markup and ids are
 * unchanged from the original single-template rendering, so `instruction-binding-form.task890
 * .test.tsx` keeps passing untouched.
 */
import { Badge, Input, Label, RadioGroup, RadioGroupItem } from '@arcaai/ui';

export interface VersionPinControlProps {
  idPrefix: string;
  approvedVersionNumber?: number | null;
  currentVersionNumber: number;
  /** `null` ⇒ follow the template's own approved version. */
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
  legend?: string;
  /**
   * TASK-1036 W3 — a library prompt is always pinned in an agent: the author may change the pinned
   * version but never clear it, so "follow approved" is not offered. A stored `null` (an agent
   * authored before the rule) renders as the approved version it resolves to today.
   */
  required?: boolean;
}

export function VersionPinControl({
  idPrefix,
  approvedVersionNumber,
  currentVersionNumber,
  value,
  onChange,
  disabled,
  legend = 'Version',
  required = false,
}: VersionPinControlProps) {
  if (required) {
    const pinned = value ?? approvedVersionNumber ?? currentVersionNumber;
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{legend}</legend>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="font-mono text-xs">
            Pinned to v{pinned}
          </Badge>
          <Label htmlFor={`${idPrefix}-pin-number`} className="text-muted-foreground text-xs font-normal">
            Change version
          </Label>
          <Input
            id={`${idPrefix}-pin-number`}
            type="number"
            min={1}
            className="w-20"
            aria-label="Pinned version number"
            value={pinned}
            disabled={disabled}
            onChange={(event) => onChange(Number(event.target.value) || 1)}
          />
        </div>
      </fieldset>
    );
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <RadioGroup
        value={value === null ? 'approved' : 'pinned'}
        onValueChange={(mode) => onChange(mode === 'approved' ? null : (approvedVersionNumber ?? currentVersionNumber))}
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${idPrefix}-follow`} value="approved" disabled={disabled} />
          <Label htmlFor={`${idPrefix}-follow`}>Follow approved{approvedVersionNumber != null ? ` (v${approvedVersionNumber})` : ''}</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${idPrefix}-pin`} value="pinned" disabled={disabled} />
          <Label htmlFor={`${idPrefix}-pin`}>Pin a version</Label>
          {value !== null ? (
            <Input
              id={`${idPrefix}-pin-number`}
              type="number"
              min={1}
              className="w-20"
              aria-label="Pinned version number"
              value={value}
              disabled={disabled}
              onChange={(event) => onChange(Number(event.target.value) || 1)}
            />
          ) : null}
        </div>
      </RadioGroup>
    </fieldset>
  );
}
