'use client';

/**
 * `PaletteRail` — registry-driven, grouped by `paletteKey`. Renders its
 * documented empty state when the registry is empty ("zero hard-coded node types…
 * if has not landed, the palette rail renders its empty state") — which is the ACTIVE
 * state against the real registry today (`contracts/registry.contract.md`).
 *
 * A filter box sits above the groups. It is pure client-side UI state (never a URL param — the
 * palette filter is a transient authoring aid, not a shareable view of the definition), matches
 * the humanized label, the raw registry `type` and the palette key, and keeps a live count so
 * the result of typing is announced rather than only visible.
 */
import { useId, useMemo, useState } from 'react';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle, Input, Label, Skeleton } from '@arcaai/ui';
import { IconPuzzle, IconSearch } from '@tabler/icons-react';
import { humanizeKey } from '../../lib/schema-form';
import type { WorkflowNodeDescriptor } from '../../api/types';
import { PaletteItem } from './palette-item';

const UTILITY_GROUP_LABEL = 'Utility';
/** The one authoring vocabulary (TASK-864) — always the first group, whatever the registry order. */
const CORE_PALETTE_KEY = 'core';

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
  const ordered = [...descriptors].sort((a, b) => Number(b.paletteKey === CORE_PALETTE_KEY) - Number(a.paletteKey === CORE_PALETTE_KEY));
  for (const descriptor of ordered) {
    const key = descriptor.paletteKey ?? UTILITY_GROUP_LABEL;
    const bucket = groups.get(key) ?? [];
    bucket.push(descriptor);
    groups.set(key, bucket);
  }
  return groups;
}

function matchesQuery(descriptor: WorkflowNodeDescriptor, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [descriptor.type, humanizeKey(descriptor.type), descriptor.paletteKey ?? ''].some((haystack) => haystack.toLowerCase().includes(needle));
}

export function PaletteRail({ descriptors, entitledFeatureKeys, loading, onAddNode }: PaletteRailProps) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  // TASK-893: the registry carries the `core` vocabulary only — nothing is deprecated, so the
  // rail offers every registered node TYPE. It does NOT offer the action catalogue: those entries
  // ride in the same payload so `effectiveNodePorts` can resolve a `core.action` instance's
  // sockets, but an action is chosen through that node's `actionKey`, never dragged onto a canvas
  // — a node whose type is an action key is one the compiler refuses (WF-C-002).
  const offered = useMemo(() => descriptors.filter((descriptor) => descriptor.kind !== 'action'), [descriptors]);
  const filtered = useMemo(() => offered.filter((descriptor) => matchesQuery(descriptor, query)), [offered, query]);

  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (offered.length === 0) {
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

  const groups = groupByPalette(filtered);

  return (
    <nav aria-label="Node palette" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={searchId} className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Filter nodes
        </Label>
        <div className="relative">
          <IconSearch aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <Input id={searchId} type="search" value={query} placeholder="Search node types" className="pl-8" onChange={(event) => setQuery(event.target.value)} />
        </div>
        <p aria-live="polite" className="text-muted-foreground text-xs">
          {filtered.length} of {offered.length} node type{offered.length === 1 ? '' : 's'}
        </p>
      </div>
      {filtered.length === 0 ? (
        <Empty>
          <EmptyMedia variant="icon">
            <IconSearch aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No matching node types</EmptyTitle>
          <EmptyDescription>Nothing in this palette matches “{query}”.</EmptyDescription>
        </Empty>
      ) : null}
      {[...groups.entries()].map(([paletteKey, items]) => (
        <div key={paletteKey} className="flex flex-col gap-2">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
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
