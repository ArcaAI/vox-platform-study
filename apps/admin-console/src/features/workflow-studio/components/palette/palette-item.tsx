'use client';

/**
 * One registry node type in the palette rail. A real `<button>` — adding a
 * node must work without dragging (WCAG 2.5.7); drag-from-palette is an enhancement layered on
 * top by the canvas composite, never the only path.
 */
import { Button } from '@arcaai/ui';
import { humanizeKey } from '../../lib/schema-form';
import type { WorkflowNodeDescriptor } from '../../api/types';
import { SafetyClassBadge } from './safety-class-badge';

export interface PaletteItemProps {
  descriptor: WorkflowNodeDescriptor;
  entitled: boolean;
  onAdd: (descriptor: WorkflowNodeDescriptor) => void;
}

export function PaletteItem({ descriptor, entitled, onAdd }: PaletteItemProps) {
  const disabledReason = !descriptor.implemented
    ? 'Not yet implemented — this node type is a placeholder.'
    : !entitled
      ? 'Not entitled — your plan does not include this node type.'
      : null;
  const label = humanizeKey(descriptor.type);

  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabledReason !== null}
      title={disabledReason ?? undefined}
      aria-describedby={disabledReason ? `${descriptor.type}-reason` : undefined}
      className="h-auto w-full min-w-0 justify-start gap-2 whitespace-normal px-3 py-2 text-left"
      onClick={() => onAdd(descriptor)}
    >
      <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <span className="truncate text-sm font-medium">{label}</span>
        {descriptor.classes.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {descriptor.classes.map((cls) => (
              <SafetyClassBadge key={cls} className={cls} />
            ))}
          </span>
        ) : null}
        {disabledReason ? (
          <span id={`${descriptor.type}-reason`} className="text-muted-foreground text-xs">
            {disabledReason}
          </span>
        ) : null}
      </span>
    </Button>
  );
}
