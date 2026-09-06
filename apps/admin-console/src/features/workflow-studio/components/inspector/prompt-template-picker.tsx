'use client';

/**
 * `PromptTemplatePicker` — the Studio's node inspector's thin wrapper over the ONE shared
 * prompt-template picker (`@/shared/prompt-picker`, TASK-890 §3.6/REQ-6 — the agents form (L5)
 * renders the exact same component). Rule 13 §Structure "one authoritative editor" means the
 * picker never grows a second implementation here: this file only adapts the shared component's
 * `string | null` value contract to the inspector's `string` config-value contract (a node's
 * `config` has no way to express "no value" other than an empty string / an absent key) and
 * keeps the narrower prop surface (`id`/`value`/`onChange`/`disabled`/`errors`) the two call
 * sites in `inspector-panel.tsx` already use.
 *
 * Before TASK-890 this component hand-rolled its own `usePromptTemplateOptions` read and a
 * static `href="/prompt-templates"` link with no way to reach the SPECIFIC template selected.
 * The shared component's quick view links to `/prompt-templates?template=<id>` instead — the
 * deep link this ticket's TDD list names — and additionally renders status, the approved-version
 * pin and the declared-variable chips, none of which this file re-implements.
 */
import { PromptTemplatePicker as SharedPromptTemplatePicker } from '@/shared/prompt-picker';

export interface PromptTemplatePickerProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  errors?: string[];
}

export function PromptTemplatePicker({ id, value, onChange, disabled, errors }: PromptTemplatePickerProps) {
  return (
    <SharedPromptTemplatePicker id={id} value={value || null} onChange={(next) => onChange(next ?? '')} disabled={disabled} errors={errors} />
  );
}
