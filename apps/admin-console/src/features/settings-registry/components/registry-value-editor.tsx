'use client';

import { CodeEditor } from '@arcaai/ui';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import type { SettingDataType } from '../api/types';

/**
 * The control for one descriptor's declared `dataType`.
 *
 * Phase 1 made non-numeric registry values first-class, so this is not a
 * numbers-only form: `boolean` gets a switch, `string[]` a line-per-entry
 * textarea, `json` the shared `CodeEditor` (line numbers, highlighting, Format,
 * live validation), `number` a numeric input, and `string`/`enum` a text input.
 *
 * `secret` deliberately has NO control. Secret values are never served by the
 * read surface and never accepted by the write lane, so rendering an input
 * would promise something the platform refuses to do. The drawer blocks that
 * case before reaching this component; the branch here is the backstop.
 */
export function RegistryValueEditor({
  id,
  dataType,
  draft,
  onChange,
  disabled,
  ariaLabel,
  describedBy,
  invalid,
}: {
  id: string;
  dataType: SettingDataType;
  draft: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  if (dataType === 'secret') {
    return (
      <p id={id} className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
        Secret values are never read back and cannot be set here.
      </p>
    );
  }

  if (dataType === 'boolean') {
    const checked = draft === 'true';
    return (
      <div className="flex items-center gap-3">
        <Switch id={id} checked={checked} disabled={disabled} aria-describedby={describedBy} onCheckedChange={(next) => onChange(String(next))} />
        {/* The state is stated in words, not carried by the switch position
            alone — rule 11 §10, never meaning by appearance alone. */}
        <Label htmlFor={id} className="font-mono text-xs">
          {checked ? 'true' : 'false'}
        </Label>
      </div>
    );
  }

  if (dataType === 'json') {
    return <CodeEditor aria-label={ariaLabel} language="json" value={draft} readOnly={disabled} onChange={onChange} className="min-h-56" />;
  }

  if (dataType === 'string[]') {
    return (
      <Textarea
        id={id}
        value={draft}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        rows={6}
        className="resize-y font-mono text-xs"
        placeholder={'one\nentry\nper line'}
      />
    );
  }

  return (
    <Input
      id={id}
      value={draft}
      disabled={disabled}
      inputMode={dataType === 'number' ? 'decimal' : undefined}
      onChange={(event) => onChange(event.target.value)}
      aria-describedby={describedBy}
      aria-invalid={invalid ? true : undefined}
      className="font-mono"
    />
  );
}
