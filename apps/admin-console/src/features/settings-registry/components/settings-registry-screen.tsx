'use client';

import { useMemo, useState } from 'react';
import { IconAdjustmentsCog, IconFilterOff, IconLock, IconWorld } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef, GroupByConfig, SortRule } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { useSession } from '@/shared/auth';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import type { FilterOption } from '@/shared/data/filter-bar';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { useSettingsCatalog } from '../api/hooks';
import { settingsRegistryKeys } from '../api/keys';
import type { EffectiveSetting, SettingCatalogItem } from '../api/types';
import { sourceScopeLabel, writeBlockFor } from './governance';
import { SettingRegistryDrawer } from './setting-registry-drawer';

/**
 * Rows carry a stable `id` for the grid; the registry is keyed by the dotted key.
 * `RowData` requires an index signature, so the row type is widened rather than
 * the catalog item being mutated.
 */
type RegistryRow = SettingCatalogItem & { id: string; [key: string]: unknown };

/** Group headers by the SERVER-side taxonomy — never a client keyword heuristic. */
const GROUP_BY: GroupByConfig<RegistryRow> = { accessor: (row) => row.category ?? null };
/** Category first so the groups stay contiguous, then key. */
const DEFAULT_SORT: SortRule[] = [
  { id: 'category', desc: false },
  { id: 'key', desc: false },
];

const TIER_OPTIONS: FilterOption[] = ['global-kv', 'db-config', 'env', 'vault-kv', 'db-secret', 'entitlement', 'redis-flag'].map((value) => ({
  value,
  label: value,
}));
const SCOPE_OPTIONS: FilterOption[] = ['system', 'tenant', 'department', 'doctor'].map((value) => ({ value, label: value }));
const EDITABILITY_OPTIONS: FilterOption[] = [
  { value: 'editable', label: 'Editable here' },
  { value: 'locked', label: 'Locked' },
  { value: 'elsewhere', label: 'Managed elsewhere' },
];

/** The filter-only column id for the derived editability facet. */
const EDITABILITY_FILTER_ID = 'editability';

/** Where a row's editability facet puts it. Derived, so it is never a column. */
function editabilityOf(item: SettingCatalogItem, isElevated: boolean): 'editable' | 'locked' | 'elsewhere' {
  if (item.locked) return 'locked';
  return writeBlockFor(item, isElevated) === null ? 'editable' : 'elsewhere';
}

function matchesSearch(item: SettingCatalogItem, needle: string): boolean {
  if (!needle) return true;
  return (
    item.key.toLowerCase().includes(needle) ||
    (item.label ?? '').toLowerCase().includes(needle) ||
    (item.description ?? '').toLowerCase().includes(needle)
  );
}

/** A short, non-wrapping rendering of any descriptor value. */
function previewValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (Array.isArray(value)) return value.length === 0 ? '[]' : value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The value a paired row's runtime actually applies.
 *
 * For an ordinary key that is just the resolved value. For a pair it is the half
 * `inForce` names: when the platform default applies, the tenant half's own read
 * still returns a value (the cascade widens) and showing THAT is what made an
 * inert SYSTEM row indistinguishable from a live one.
 */
function inForceValue(setting: EffectiveSetting): unknown {
  if (setting.pair && setting.pair.inForce === 'platform') return setting.pair.platformValue;
  return setting.value;
}

/**
 * Settings registry (/settings-registry, tier 20-29 shared).
 *
 * The descriptor-driven editor over `GET admin/settings/catalog` +
 * `PUT/DELETE admin/settings/registry/:key`.
 *
 * ── WHY AN AdminDataGrid AND NOT A TABLE PER CATEGORY (TASK-932 R-7) ────────
 * The screen used to render one plain `<Table>` per category with a bespoke
 * search box and a single "editable only" toggle. At 219 descriptors across 26
 * categories that is a wall: no sorting, no faceting, no virtualisation, a
 * different filter idiom from every other console list, and rows that wrapped
 * badly at any width the owner actually uses. `AdminDataGrid` is what the
 * `/settings` screen already uses, so converging on it makes this list behave
 * like the rest of the console rather than like its own small app.
 *
 * ── WHY THE FILTERING IS CLIENT-SIDE HERE, UNIQUELY ────────────────────────
 * `AdminDataGrid` is server-driven everywhere else (`manual: true`), and the
 * screen owns the fetch. This catalog is not a server list at all: it is ONE
 * in-memory registry served whole in a single call, with no list endpoint to
 * page or filter. So the screen applies the grid's own query state locally and
 * hands back the page it asked for — the URL binding, the facets and the pager
 * behave identically, and the alternative (inventing a paged catalog endpoint)
 * would add a server surface to solve a problem that does not exist at this
 * size.
 *
 * ── VALUES ARE STILL LAZY ──────────────────────────────────────────────────
 * The registry lane is key-addressed with one ETag per key and has no bulk read,
 * so eagerly resolving the list would cost one request per descriptor to paint a
 * list nobody has scrolled. The value column therefore shows the DESCRIPTOR
 * DEFAULT until a key has actually been opened, and says so in the Source
 * column; once opened, the resolved value and the tier that answered are read
 * from the query cache. Showing a default while labelling it "code default" is
 * honest; showing it as "the effective value" would not be.
 */
export function SettingsRegistryScreen() {
  const session = useSession();
  // The EFFECTIVE identity: while impersonating, the screen must behave as the
  // impersonated tenant admin, not as the operator behind them.
  const isElevated = session.data?.effectiveIsElevated ?? session.data?.isElevated ?? false;
  const workingTenantName = session.data?.workingTenantName ?? null;
  const catalogQuery = useSettingsCatalog();
  const queryClient = useQueryClient();

  const query = useAdminGridParams({ defaultSort: DEFAULT_SORT });
  const [active, setActive] = useState<SettingCatalogItem | null>(null);
  // Deep-linkable selection, and the signal that re-reads the value cache when a
  // drawer closes (an opened key now has a resolved value to show).
  const [selectedKey, setSelectedKey] = useQueryState('key', parseAsString);

  const items = useMemo(() => catalogQuery.data?.items ?? [], [catalogQuery.data]);

  /**
   * TASK-969 F-1 — the PLATFORM half of every declared pair.
   *
   * `requireMedical` and `includeReasoning` each exist as two keys split by
   * delivery channel (a cached per-process PULL snapshot vs a per-request PUSH),
   * and both halves are platform-admin-only. The split is a transport detail
   * with no audience, and rendering it as two near-identically-named rows is
   * what let an admin edit the half whose SYSTEM row nothing reads.
   *
   * So the pair is listed ONCE, on the TENANT half, and the platform half is
   * suppressed as a separate entry. Which half survives is not arbitrary: the
   * tenant half is the one that DECLARES the pairing (`platformTierKey`), and it
   * is the one whose read carries both values plus `inForce` — the platform half
   * carries no back-pointer and no twin's value, so a row built on it could
   * neither name its partner nor say which is in force without a second lookup
   * the contract does not provide.
   *
   * Derived from the catalog itself, so it is self-correcting: a catalog that
   * serves only one half (RBAC, or a gateway that has not shipped the field)
   * suppresses nothing and simply lists what it was given.
   */
  const twinKeys = useMemo(() => {
    const set = new Set<string>();
    for (const entry of items) if (entry.platformTierKey) set.add(entry.platformTierKey);
    return set;
  }, [items]);

  // m3 — `?key=` was written on every row open but never READ back: a shared
  // deep link landed on the plain list with the drawer closed. Seed the
  // active drawer from the param once the catalog carries a matching item —
  // the render-time derived-state pattern (see `FilterSearch`'s own re-sync),
  // not an effect: `active` already set means the admin picked a row
  // themselves (or this already opened one), so it never fights that choice,
  // and the seed always lands in the SAME commit as the catalog arriving.
  if (active === null && selectedKey) {
    // A link to the SUPPRESSED platform half lands on the row that owns it —
    // two editors for one concept is the thing this ticket removes, and old
    // links must not be the way back to the second one.
    const found = items.find((item) => item.key === selectedKey && !twinKeys.has(item.key)) ?? items.find((item) => item.platformTierKey === selectedKey);
    if (found) setActive(found);
  }

  const categoryOptions = useMemo<FilterOption[]>(
    () => (catalogQuery.data?.categories ?? []).map((value) => ({ value, label: value })),
    [catalogQuery.data],
  );

  /**
   * Resolved values for keys the admin has already opened, read from the query
   * cache on every render.
   *
   * Deliberately NOT memoized and deliberately NOT a cache subscription. A memo
   * would need a dependency that says "a value may have arrived", which nothing
   * here honestly has; a subscription would re-render the whole grid on every
   * unrelated query in the app. The map holds at most the handful of keys an
   * admin has actually opened, so rebuilding it costs nothing and is always
   * current.
   */
  const resolved = new Map<string, EffectiveSetting>();
  for (const [, data] of queryClient.getQueriesData<{ data: EffectiveSetting }>({ queryKey: [...settingsRegistryKeys.root, 'setting'] })) {
    if (data?.data?.key) resolved.set(data.data.key, data.data);
  }

  const filtered = useMemo(() => {
    const needle = (query.queryState.globalSearch ?? '').trim().toLowerCase();
    const ruleValues = (id: string): string[] => {
      const rule = query.queryState.filters.find((r) => r.id === id);
      if (!rule) return [];
      return Array.isArray(rule.value) ? rule.value.map(String) : [String(rule.value)];
    };
    const categories = ruleValues('category');
    const tiers = ruleValues('tier');
    const scopes = ruleValues('maxScope');
    const editability = ruleValues(EDITABILITY_FILTER_ID);

    return items.filter((item) => {
      // The platform half of a pair is edited through its twin's row, never as
      // an entry of its own.
      if (twinKeys.has(item.key)) return false;
      if (categories.length > 0 && !categories.includes(item.category)) return false;
      if (tiers.length > 0 && !tiers.includes(item.tier)) return false;
      if (scopes.length > 0 && !scopes.includes(item.maxScope)) return false;
      if (editability.length > 0 && !editability.includes(editabilityOf(item, isElevated))) return false;
      return matchesSearch(item, needle);
    });
  }, [items, twinKeys, query.queryState, isElevated]);

  const sorted = useMemo(() => {
    const rules = query.queryState.sorting.length > 0 ? query.queryState.sorting : DEFAULT_SORT;
    const rows = filtered.map<RegistryRow>((item) => ({ ...item, id: item.key }));
    return rows.sort((a, b) => {
      for (const rule of rules) {
        const left = String(a[rule.id] ?? '');
        const right = String(b[rule.id] ?? '');
        const compared = left.localeCompare(right);
        if (compared !== 0) return rule.desc ? -compared : compared;
      }
      return 0;
    });
  }, [filtered, query.queryState.sorting]);

  const page = query.queryState.pagination.mode === 'offset' ? query.queryState.pagination.page : 0;
  const limit = query.queryState.pagination.limit;
  const rows = useMemo(() => sorted.slice(page * limit, page * limit + limit), [sorted, page, limit]);

  const columns: ColumnDef<RegistryRow>[] = [
    {
      accessorKey: 'key',
      header: 'Key',
      meta: { label: 'Key' },
      size: 300,
      minSize: 180,
      cell: ({ row }) => (
        // `title` (not a tooltip primitive) so the full key is reachable on a
        // truncated cell without a hover-only affordance in a virtualised row.
        <span className="block truncate font-mono text-xs" title={row.original.key}>
          {row.original.key}
        </span>
      ),
    },
    {
      accessorKey: 'label',
      header: 'Label',
      meta: { label: 'Label' },
      size: 220,
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate" title={row.original.label ?? row.original.key}>
            {row.original.label ?? '—'}
          </span>
          {row.original.globalOnly ? (
            <Badge variant="secondary" className="shrink-0 gap-1">
              <IconWorld aria-hidden className="size-3" />
              Platform-wide
            </Badge>
          ) : null}
          {row.original.killSwitch ? (
            <Badge variant="destructive" className="shrink-0">
              Kill-switch
            </Badge>
          ) : null}
          {row.original.floorDirection ? (
            <Badge variant="outline" className="shrink-0">
              Tighten-only
            </Badge>
          ) : null}
          {row.original.platformTierKey ? (
            <Badge variant="outline" className="shrink-0" title={`Platform default: ${row.original.platformTierKey}`}>
              Platform + tenant
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      accessorKey: 'category',
      header: 'Category',
      enableSorting: false,
      meta: { label: 'Category', variant: 'multiSelect', options: categoryOptions },
      size: 170,
      cell: ({ row }) => <span className="text-muted-foreground truncate">{row.original.category}</span>,
    },
    {
      accessorKey: 'tier',
      header: 'Tier',
      enableSorting: false,
      meta: { label: 'Tier', variant: 'multiSelect', options: TIER_OPTIONS },
      size: 120,
      cell: ({ row }) => (
        <Badge variant="outline" className="font-mono text-xs">
          {row.original.tier}
        </Badge>
      ),
    },
    {
      accessorKey: 'maxScope',
      header: 'Max scope',
      enableSorting: false,
      meta: { label: 'Max scope', variant: 'multiSelect', options: SCOPE_OPTIONS },
      size: 110,
      cell: ({ row }) => <span className="text-muted-foreground text-xs">{row.original.maxScope}</span>,
    },
    {
      id: 'value',
      header: 'Effective value',
      enableSorting: false,
      meta: { label: 'Effective value' },
      size: 200,
      cell: ({ row }) => {
        const known = resolved.get(row.original.key);
        const shown = known ? inForceValue(known) : row.original.default;
        return (
          <span className="block truncate font-mono text-xs" title={previewValue(shown)}>
            {previewValue(shown)}
          </span>
        );
      },
    },
    {
      id: 'source',
      header: 'Source',
      enableSorting: false,
      meta: { label: 'Source' },
      size: 140,
      cell: ({ row }) => {
        const known = resolved.get(row.original.key);
        // On a paired row `sourceScope` describes the tenant half's own cascade,
        // which is exactly the reading that misled — `pair.inForce` is the
        // server's statement of which half the runtime applies.
        const source = known ? (known.pair ? sourceScopeLabel(known.pair.inForce === 'platform' ? 'system' : 'tenant') : sourceScopeLabel(known.sourceScope)) : 'code default';
        return <span className="text-muted-foreground text-xs">{source}</span>;
      },
    },
    {
      // Derived facet, never rendered: `editability` is computed from tier +
      // lock + privilege, so it is a filter-only virtual column.
      accessorKey: EDITABILITY_FILTER_ID,
      enableSorting: false,
      meta: { label: 'Editability', variant: 'multiSelect', filterOnly: true, options: EDITABILITY_OPTIONS },
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      meta: { label: 'Actions' },
      enableSorting: false,
      enableHiding: false,
      size: 120,
      minSize: 110,
      cell: ({ row }) => {
        const block = writeBlockFor(row.original, isElevated);
        return (
          <div className="flex items-center justify-end">
            <Button
              variant="outline"
              size="sm"
              // The key rides in `aria-label` rather than an sr-only span so it
              // appears in the DOM once. The accessible name still starts with
              // the visible word, satisfying label-in-name (WCAG 2.5.3).
              aria-label={`${row.original.locked ? 'Locked' : block ? 'View' : 'Edit'} ${row.original.key}`}
              onClick={(event) => {
                event.stopPropagation();
                setActive(row.original);
                void setSelectedKey(row.original.key);
              }}
            >
              {row.original.locked ? (
                <>
                  <IconLock aria-hidden />
                  Locked
                </>
              ) : block ? (
                'View'
              ) : (
                'Edit'
              )}
            </Button>
          </div>
        );
      },
    },
  ];

  const editableCount = useMemo(() => items.filter((item) => writeBlockFor(item, isElevated) === null).length, [items, isElevated]);

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            // A tenant admin sees only the keys its own tenant can hold an
            // opinion on (TASK-932 R-1), so calling the screen "Settings
            // registry" would promise a platform inventory it does not get.
            title={isElevated ? 'Settings registry' : 'Tenant settings'}
            meta={
              <span>
                {isElevated
                  ? 'every descriptor-governed setting · grouped by category · optimistic concurrency on every write'
                  : 'the settings your tenant can set · optimistic concurrency on every write'}
              </span>
            }
          />
        }
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
        <AdminDataGrid<RegistryRow>
          gridId="settings-registry"
          aria-label="Settings registry"
          columns={columns}
          rows={rows}
          total={filtered.length}
          groupBy={GROUP_BY}
          queryState={query.queryState}
          onQueryStateChange={query.setQueryState}
          isLoading={catalogQuery.isLoading || session.isPending}
          isBusy={catalogQuery.isFetching && !catalogQuery.isLoading}
          error={catalogQuery.error}
          onRetry={() => void catalogQuery.refetch()}
          onRowClick={(row) => {
            setActive(row);
            void setSelectedKey(row.key);
          }}
          emptyState={
            <EmptyState
              icon={IconAdjustmentsCog}
              title="No settings in the registry"
              description="The settings registry exposes no keys for your role."
            />
          }
          emptyFilteredState={
            <EmptyState
              icon={IconFilterOff}
              title="No settings match these filters"
              description="Clear the search or the category, tier, scope and editability facets to see the rest of the catalog."
              action={
                <Button variant="outline" onClick={() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] })}>
                  <IconFilterOff aria-hidden />
                  Clear filters
                </Button>
              }
            />
          }
        />
      </ScreenTemplate>

      <SettingRegistryDrawer
        item={active}
        open={active !== null}
        onOpenChange={(next) => {
          if (!next) {
            setActive(null);
            void setSelectedKey(null);
          }
        }}
        isElevated={isElevated}
        workingTenantName={workingTenantName}
      />
    </>
  );
}
