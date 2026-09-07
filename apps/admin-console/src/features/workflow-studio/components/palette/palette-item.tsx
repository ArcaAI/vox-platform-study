'use client';

/**
 * One registry node type in the palette rail. A real `<button>` — adding a
 * node must work without dragging (WCAG 2.5.7); drag-from-palette is an enhancement layered on
 * top by the canvas composite, never the only path.
 *
 * TASK-890 (black-box J4-F1): that drag now exists. The item is `draggable` and stamps its
 * registry type on the `DataTransfer` (`lib/palette-drag.ts`); the canvas projects the drop point
 * and the editor adds the node there. A DISABLED item (unimplemented / unentitled) is not
 * draggable either, so the two paths refuse in step rather than the drag becoming a way around
 * the gate.
 *
 * TASK-893 B1/§4.4 — the owner rejected the fully-rounded shadcn `<Button>` ("the card must not
 * max-rounded"): `Button`'s base class carries `rounded-control`
 * (`--radius-control: calc(--hope-radius-base * 999)`, a pill). This is now a real card —
 * `rounded-md`, an icon, the name, and a one-line purpose — built directly on a styled `<button>`
 * rather than the `Button` primitive, so it keeps its semantic element and keyboard operability
 * without inheriting the pill radius.
 */
import { cn } from '@arcaai/ui';
import { writePaletteDragType } from '../../lib/palette-drag';
import { humanizeKey } from '../../lib/schema-form';
import type { WorkflowNodeDescriptor } from '../../api/types';
import { iconForNodeType } from './node-type-icon';
import { SafetyClassBadge } from './safety-class-badge';

export interface PaletteItemProps {
  descriptor: WorkflowNodeDescriptor;
  entitled: boolean;
  onAdd: (descriptor: WorkflowNodeDescriptor) => void;
}

/**
 * The card's one-line purpose. `configSchema` is `NODE_CONFIG_SCHEMAS[type]` delivered verbatim
 * over the wire (`node-registry.ts`), so a `summary` authored there (TASK-893 B2) reaches this
 * card with no change to the frozen `api/types.ts` DTO — `configSchema` is already typed as an
 * opaque `Record<string, unknown> | null`. Absent for every node type Phase 1 has not annotated
 * yet (every deprecated type, and any `core.*` entry with no config schema at all).
 */
function purposeOf(descriptor: WorkflowNodeDescriptor): string | undefined {
  const schema = descriptor.configSchema;
  if (!schema || typeof schema !== 'object') return undefined;
  const summary = (schema as Record<string, unknown>).summary;
  return typeof summary === 'string' && summary.length > 0 ? summary : undefined;
}

export function PaletteItem({ descriptor, entitled, onAdd }: PaletteItemProps) {
  const disabledReason = !descriptor.implemented
    ? 'Not yet implemented — this node type is a placeholder.'
    : !entitled
      ? 'Not entitled — your plan does not include this node type.'
      : null;
  const label = humanizeKey(descriptor.type);
  const purpose = purposeOf(descriptor);
  const Icon = iconForNodeType(descriptor.type);

  return (
    <button
      type="button"
      disabled={disabledReason !== null}
      title={disabledReason ?? undefined}
      aria-describedby={disabledReason ? `${descriptor.type}-reason` : undefined}
      draggable={disabledReason === null}
      onDragStart={(event) => writePaletteDragType(event.dataTransfer, descriptor.type)}
      onClick={() => onAdd(descriptor)}
      className={cn(
        'flex w-full min-w-0 items-start gap-3 rounded-md border bg-card p-3 text-left transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-visible:border-ring focus-visible:ring-ring outline-hidden focus-visible:ring-[3px]',
        'active:scale-[var(--scale-pressed)]',
        'disabled:pointer-events-none disabled:opacity-50',
      )}
    >
      <Icon aria-hidden="true" className="text-muted-foreground mt-0.5 size-5 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <span className="truncate text-sm font-medium">{label}</span>
        {purpose ? <span className="text-muted-foreground line-clamp-1 text-xs">{purpose}</span> : null}
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
    </button>
  );
}
