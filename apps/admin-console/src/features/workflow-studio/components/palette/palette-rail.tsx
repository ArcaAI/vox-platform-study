'use client';

/**
 * `PaletteRail` (TASK-719 Task 12) — registry-driven, grouped by `paletteKey`. Renders its
 * documented empty state when the registry is empty (README §1: "zero hard-coded node types…
 * if TASK-720 has not landed, the palette rail renders its empty state") — which is the ACTIVE
 * state against the real registry today (`contracts/registry.contract.md`).
 */
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle, Skeleton } from '@arcaai/ui';
import { IconPuzzle } from '@tabler/icons-react';
import { humanizeKey } from '../../lib/schema-form';
import type { WorkflowNodeDescriptor } from '../../api/types';
import { PaletteItem } from './palette-item';

const UTILITY_GROUP_LABEL = 'Utility';

export interface PaletteRailProps {
  descriptors: WorkflowNodeDescriptor[];
  /** `undefined` = entitlement gating unknown (nothing gated); an explicit `Set` gates any
   *  descriptor whose `entitlementKey` is not a member. */
  entitledFeatureKeys?: Set<string>;
  loading?: boolean;
  onAddNode: (descriptor: WorkflowNodeDescriptor) => void;
}

function groupByPalette(descriptors: WorkflowNodeDescriptor[]): Map<string, WorkflowNodeDescriptor[]> {
  const groups = new Map<string, WorkflowNodeDescriptor[]>();
  for (const descriptor of descriptors) {
    const key = descriptor.paletteKey ?? UTILITY_GROUP_LABEL;
    const bucket = groups.get(key) ?? [];
    bucket.push(descriptor);
    groups.set(key, bucket);
  }
  return groups;
}

export function PaletteRail({ descriptors, entitledFeatureKeys, loading, onAddNode }: PaletteRailProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (descriptors.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <IconPuzzle aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No node types available</EmptyTitle>
        <EmptyDescription>The node registry has no entries yet for this palette.</EmptyDescription>
      </Empty>
    );
  }

  const groups = groupByPalette(descriptors);

  return (
    <nav aria-label="Node palette" className="flex flex-col gap-4">
      {[...groups.entries()].map(([paletteKey, items]) => (
        <div key={paletteKey} className="flex flex-col gap-2">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {paletteKey === UTILITY_GROUP_LABEL ? UTILITY_GROUP_LABEL : humanizeKey(paletteKey)}
          </h3>
          <div className="flex flex-col gap-2">
            {items.map((descriptor) => (
              <PaletteItem
                key={descriptor.type}
                descriptor={descriptor}
                entitled={descriptor.entitlementKey === null || (entitledFeatureKeys?.has(descriptor.entitlementKey) ?? true)}
                onAdd={onAddNode}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
