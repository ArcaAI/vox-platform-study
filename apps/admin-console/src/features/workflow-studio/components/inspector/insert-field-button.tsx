'use client';

/**
 * `InsertFieldButton` — TASK-1036 review R-C #5, §10.1 "One picker everywhere ... opens on Choose a
 * field, Change, **+ Insert field**, or typing `{{`".
 *
 * Sits beside every text-with-fields editor (an Inputs-panel template, a CEL condition, a
 * prompt-variable override) and opens the SAME four-group picker; the pick is handed to `onPick`,
 * which writes it at the editor's cursor (`TemplateEditorHandle.insertAtCursor`). It is the
 * pointer-and-keyboard path to a field for an author who never types `{{` or `/` (WCAG 2.5.7's
 * spirit: the typed trigger is never the only way in).
 */
import { IconPlus } from '@tabler/icons-react';
import type { PickerGroup, PickerItem } from '../../lib/picker-model';
import { FieldPicker } from './field-picker';

export interface InsertFieldButtonProps {
  groups: readonly PickerGroup[];
  /** The field's name, for the accessible name ("Insert field into summary"). */
  fieldName: string;
  onPick: (item: PickerItem) => void;
  /** The type the editor holds (`text` for a template) — ranks what fits first. */
  targetType?: string;
  disabled?: boolean;
}

export function InsertFieldButton({ groups, fieldName, onPick, targetType, disabled }: InsertFieldButtonProps) {
  return (
    <FieldPicker
      groups={groups}
      targetType={targetType}
      disabled={disabled}
      triggerVariant="ghost"
      triggerClassName="self-start"
      triggerLabel={
        <>
          <IconPlus aria-hidden="true" />
          <span>
            Insert field<span className="sr-only"> into {fieldName}</span>
          </span>
        </>
      }
      onPick={onPick}
    />
  );
}

/**
 * Picker groups for an editor that only has a flat completion list (the CEL / prompt-variable
 * fields outside the composer): one group per scope, by each path's ROOT. Every item is offered;
 * nothing is ranked or blocked, because there is no target type to rank against.
 */
export function groupsFromPaths(paths: ReadonlyArray<{ path: string; type?: string; phiClass?: string | null; description?: string | null }>): PickerGroup[] {
  const groups: Record<PickerGroup['key'], PickerGroup> = {
    steps: { key: 'steps', label: 'Earlier steps', items: [] },
    context: { key: 'context', label: 'Context', items: [] },
    consultation: { key: 'consultation', label: 'Consultation', items: [] },
    run: { key: 'run', label: 'Run & variables', items: [] },
  };
  const seen = new Set<string>();
  for (const entry of paths) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const root = entry.path.split('.')[0] ?? '';
    const key: PickerGroup['key'] = root === 'nodes' ? 'steps' : root === 'consultation' ? 'consultation' : root === 'trigger' || root === 'context' ? 'context' : 'run';
    groups[key].items.push({
      path: entry.path,
      raw: entry.path,
      type: (entry.type ?? 'any') as PickerItem['type'],
      phiClass: entry.phiClass === 'PHI' || entry.phiClass === 'NON_PHI' ? entry.phiClass : null,
      description: entry.description ?? '',
      scope: key,
    });
  }
  return Object.values(groups).filter((group) => group.items.length > 0);
}
