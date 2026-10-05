'use client';

/**
 * TASK-1036 §10.1 — a binding as a chip: shown by step LABEL, stored by id (the id is the
 * tooltip, OD-20), coloured by scope and saying it, with a PHI badge when the value is PHI.
 */
import { Badge, cn } from '@arcaai/ui';
import type { GraphStoreNode } from '../../store/types';
import { describeBinding } from '../../lib/binding-display';
import { useNodeNamingContext } from '../node-naming-context';
import { SCOPE_CLASS, SCOPE_NAME } from './scope-style';

export interface BindingChipProps {
  binding: unknown;
  nodes: ReadonlyArray<Pick<GraphStoreNode, 'id' | 'type' | 'config'>>;
  phi?: boolean;
  className?: string;
}

export function BindingChip({ binding, nodes, phi, className }: BindingChipProps) {
  const naming = useNodeNamingContext();
  const chip = describeBinding(binding, nodes, naming);
  if (!chip) return null;
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1', className)}>
      <span
        data-slot="binding-chip"
        data-scope={chip.scope}
        title={chip.title}
        className={cn('inline-flex min-w-0 items-center rounded-md border px-1.5 py-0.5 text-xs', chip.kind === 'from' || chip.kind === 'firstOf' ? 'font-mono' : '', SCOPE_CLASS[chip.scope])}
      >
        <span className="sr-only">{SCOPE_NAME[chip.scope]}: </span>
        <span className="truncate">{chip.label}</span>
      </span>
      {phi ? (
        <Badge variant="outline" className="border-destructive text-destructive px-1 text-[10px]">
          PHI
        </Badge>
      ) : null}
    </span>
  );
}
