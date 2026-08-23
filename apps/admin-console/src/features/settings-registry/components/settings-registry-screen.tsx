'use client';

import { useMemo, useState } from 'react';
import { IconAdjustmentsCog, IconFilterOff, IconLock, IconSearch, IconWorld } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { useSession } from '@/shared/auth';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useSettingsCatalog } from '../api/hooks';
import type { SettingCatalogItem } from '../api/types';
import { writeBlockFor } from './governance';
import { SettingRegistryDrawer } from './setting-registry-drawer';

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {Array.from({ length: 3 }, (_, group) => (
        <div key={group} className="flex flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <div className="flex flex-col gap-2 rounded-md border p-3">
            {Array.from({ length: 4 }, (_, row) => (
              <Skeleton key={row} className="h-8 w-full" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One category's keys. Grouping by `category` is server-side taxonomy, not a client heuristic. */
function CategorySection({
  category,
  items,
  isElevated,
  onOpen,
}: {
  category: string;
  items: SettingCatalogItem[];
  isElevated: boolean;
  onOpen: (item: SettingCatalogItem) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">
        {category} <span className="text-muted-foreground font-normal">({items.length})</span>
      </h2>
      <div className="rounded-md border">
        <Table aria-label={`${category} settings`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Key</TableHead>
              <TableHead scope="col">Type</TableHead>
              <TableHead scope="col">Scope</TableHead>
              <TableHead scope="col">Editable</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const block = writeBlockFor(item, isElevated);
              return (
                <TableRow key={item.key}>
                  <TableCell className="align-top">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs font-medium">{item.key}</span>
                        {item.globalOnly ? (
                          <Badge variant="secondary" className="gap-1">
                            <IconWorld aria-hidden className="size-3" />
                            Platform-wide
                          </Badge>
                        ) : null}
                        {item.killSwitch ? <Badge variant="destructive">Kill-switch</Badge> : null}
                        {item.failMode === 'closed' ? <Badge variant="outline">Required</Badge> : null}
                        {item.floorDirection ? <Badge variant="outline">Tighten-only</Badge> : null}
                      </div>
                      {item.label ? <span className="text-xs">{item.label}</span> : null}
                      {item.description ? <span className="text-muted-foreground text-xs">{item.description}</span> : null}
                    </div>
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs">{item.dataType}</TableCell>
                  <TableCell className="align-top text-xs">{item.maxScope}</TableCell>
                  <TableCell className="align-top text-xs">
                    {/* Not colour alone: the cell says which, in words. */}
                    {block ? (
                      <span className="text-muted-foreground inline-flex items-center gap-1">
                        <IconLock aria-hidden className="size-3" />
                        {block.label}
                      </span>
                    ) : (
                      <span>Yes</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {/* The key rides in `aria-label` rather than an sr-only
                        span so it appears in the DOM once. The accessible name
                        still starts with the visible word, satisfying
                        label-in-name (WCAG 2.5.3) for voice control. */}
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`${block ? 'View' : 'Edit'} ${item.key}`}
                      onClick={() => onOpen(item)}
                    >
                      {block ? 'View' : 'Edit'}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/**
 * Settings registry (/settings-registry, tier 20-29 shared).
 *
 * The generic, descriptor-driven editor over `GET admin/settings/catalog` +
 * `PUT admin/settings/registry/:key`. Both routes have been fully functional
 * with exactly ONE console consumer — the Agentic Context tab, which shows a
 * single hardcoded category — so 210 descriptors had an API and no button.
 *
 * Relationship to `/settings`: that screen is the LEGACY raw-row CRUD over the
 * same table, keyed by a key-name regex rather than by descriptors, and it
 * keeps the row and SECRET administration it already owns. This screen owns the
 * descriptor-governed keys, which is where `tier` / `maxScope` / `failMode` /
 * `killSwitch` / `floorDirection` / `sourceScope` actually mean something. They
 * address different things, so rule 13's one-authoritative-editor rule holds.
 *
 * Values are fetched LAZILY, per key, when a row is opened: the registry lane
 * is key-addressed with one ETag per key and there is no bulk read, so eager
 * loading would mean 210 requests to paint a list.
 */
export function SettingsRegistryScreen() {
  const session = useSession();
  const isElevated = session.data?.isElevated ?? false;
  const catalogQuery = useSettingsCatalog();

  const [search, setSearch] = useQueryState('q', parseAsString.withDefault(''));
  const [category, setCategory] = useQueryState('category', parseAsString.withDefault(''));
  const [editableOnly, setEditableOnly] = useState(false);
  const [active, setActive] = useState<SettingCatalogItem | null>(null);

  // Memoized: `?? []` mints a fresh array on every render, which would make the
  // filter/group memos below recompute over 210 descriptors each time.
  const items = useMemo(() => catalogQuery.data?.items ?? [], [catalogQuery.data]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((item) => {
      if (category && item.category !== category) return false;
      if (editableOnly && writeBlockFor(item, isElevated) !== null) return false;
      if (!needle) return true;
      return (
        item.key.toLowerCase().includes(needle) ||
        (item.label ?? '').toLowerCase().includes(needle) ||
        (item.description ?? '').toLowerCase().includes(needle)
      );
    });
  }, [items, search, category, editableOnly, isElevated]);

  /** Category → its matching keys, in the catalog's sorted category order. */
  const grouped = useMemo(() => {
    const map = new Map<string, SettingCatalogItem[]>();
    for (const item of filtered) {
      const bucket = map.get(item.category);
      if (bucket) bucket.push(item);
      else map.set(item.category, [item]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const editableCount = useMemo(() => items.filter((item) => writeBlockFor(item, isElevated) === null).length, [items, isElevated]);
  const hasFilters = search !== '' || category !== '' || editableOnly;

  const header = (
    <PageHeader
      title="Settings registry"
      meta={<span>every descriptor-governed setting &middot; grouped by category &middot; optimistic concurrency on every write</span>}
    />
  );

  const toolbar = (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-56 flex-1 flex-col gap-1.5">
        <Label htmlFor="registry-search">Search</Label>
        <div className="relative">
          <IconSearch aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <Input
            id="registry-search"
            value={search}
            placeholder="key, label or description"
            className="pl-8"
            onChange={(event) => void setSearch(event.target.value || null)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="registry-category">Category</Label>
        <select
          id="registry-category"
          value={category}
          onChange={(event) => void setCategory(event.target.value || null)}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="">All categories</option>
          {(catalogQuery.data?.categories ?? []).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <Button variant={editableOnly ? 'default' : 'outline'} size="sm" aria-pressed={editableOnly} onClick={() => setEditableOnly((on) => !on)}>
        Editable here only
      </Button>
      {hasFilters ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void setSearch(null);
            void setCategory(null);
            setEditableOnly(false);
          }}
        >
          <IconFilterOff aria-hidden />
          Clear
        </Button>
      ) : null}
    </div>
  );

  if (catalogQuery.isPending || session.isPending) {
    return (
      <ScreenTemplate header={header}>
        <ListSkeleton />
      </ScreenTemplate>
    );
  }

  if (catalogQuery.error) {
    return (
      <ScreenTemplate header={header}>
        <ErrorState error={catalogQuery.error} onRetry={() => void catalogQuery.refetch()} />
      </ScreenTemplate>
    );
  }

  return (
    <ScreenTemplate
      header={header}
      toolbar={toolbar}
      footer={
        <StatusFooter
          start={
            <span>
              {filtered.length} of {items.length} setting(s) &middot; {editableCount} editable here
            </span>
          }
          end={
            <span aria-hidden className="font-mono">
              GET /admin/settings/catalog
            </span>
          }
        />
      }
    >
      {grouped.length === 0 ? (
        <EmptyState
          icon={IconAdjustmentsCog}
          title={hasFilters ? 'No settings match these filters' : 'No settings in the registry'}
          description={
            hasFilters
              ? 'Clear the search, category or editability filter to see the rest of the catalog.'
              : 'The settings registry exposes no keys for your role.'
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map(([name, groupItems]) => (
            <CategorySection key={name} category={name} items={groupItems} isElevated={isElevated} onOpen={setActive} />
          ))}
        </div>
      )}

      <SettingRegistryDrawer item={active} open={active !== null} onOpenChange={(next) => !next && setActive(null)} isElevated={isElevated} />
    </ScreenTemplate>
  );
}
