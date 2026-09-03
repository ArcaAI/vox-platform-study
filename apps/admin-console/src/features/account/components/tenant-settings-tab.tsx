'use client';

import { useId, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { IconAdjustmentsHorizontal, IconLock } from '@tabler/icons-react';
import { toast } from 'sonner';
import { cn } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { formatRelativeTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useViewportTier } from '@/shared/layout/use-viewport-tier';
import type { TenantConfig } from '@/features/tenants/api/types';
import { useMyTenantConfigs, useUpdateMyTenantConfigs } from '../api/hooks';
import { CONFIG_CATEGORIES, type CategoryId, controlFor, groupByCategory } from '../lib/config-categories';

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

function isReadOnly(config: TenantConfig): boolean {
  return Boolean(config.locked) || !config.id;
}

/** Type-appropriate control for one row (rule 11 §9; controlFor decides the kind). */
function ConfigControl({
  config,
  value,
  disabled,
  onChange,
}: {
  config: TenantConfig;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const label = `Value for ${config.key}`;
  switch (controlFor(config.dataType)) {
    case 'switch':
      return (
        <div className="flex items-center gap-2">
          <Switch aria-label={label} checked={value === 'true'} disabled={disabled} onCheckedChange={(checked) => onChange(String(checked))} />
          <span className="text-muted-foreground font-mono text-xs">{value === 'true' ? 'true' : 'false'}</span>
        </div>
      );
    case 'textarea':
      return (
        <Textarea
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          rows={4}
          className="resize-none font-mono text-xs"
        />
      );
    case 'number':
      return (
        <Input
          aria-label={label}
          inputMode="decimal"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-full max-w-56 font-mono text-xs"
        />
      );
    case 'date':
      return (
        <Input
          aria-label={label}
          type="date"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-full max-w-56 text-xs"
        />
      );
    default:
      return (
        <Input
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-full max-w-72 font-mono text-xs"
        />
      );
  }
}

function SettingsSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]" aria-hidden>
      <div className="hidden flex-col gap-2 lg:flex">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
      <Card className="gap-4 p-6">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-9 w-full max-w-72" />
          </div>
        ))}
      </Card>
    </div>
  );
}

/**
 * Settings tab: a category rail (chip row on mobile) plus a
 * focused form pane. Editable rows draft locally; a per-category save bar fires
 * sequential per-row PATCH /tenants/me/config with per-row If-Match (the gateway
 * route is `@RequiresIfMatch()` and applies the header version to every row, so
 * a single heterogeneous batch is impossible — ). A 412
 * stops the run, keeps drafts ("no silent loss") and reloads versions.
 */
export function TenantSettingsTab({ readOnly = false }: { readOnly?: boolean } = {}) {
  const uid = useId();
  const tier = useViewportTier();
  const configsQuery = useMyTenantConfigs();
  const updateConfigs = useUpdateMyTenantConfigs();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [categoryParam, setCategoryParam] = useQueryState('category', parseAsString.withDefault('general'));

  // Local state is authoritative for the active category (survives unrelated
  // re-renders); the URL param is mirrored for deep-linking and seeds the
  // initial selection.
  const [selectedId, setSelectedId] = useState<CategoryId | null>(null);

  const configRows = useMemo(() => configsQuery.data?.data.data ?? [], [configsQuery.data]);
  const groups = useMemo(() => groupByCategory(configRows), [configRows]);
  // Default when nothing is explicitly selected: General when it has rows,
  // else the first populated category (avoids an empty default pane).
  const firstPopulated = (CONFIG_CATEGORIES.find((c) => groups[c.id].length > 0)?.id ?? 'general') as CategoryId;
  const deepLinked = CONFIG_CATEGORIES.find((c) => c.id === categoryParam && c.id !== 'general')?.id as CategoryId | undefined;
  const defaultActive: CategoryId = deepLinked ?? (groups.general.length > 0 ? 'general' : firstPopulated);
  const activeCategory: CategoryId = selectedId ?? defaultActive;
  const activeMeta = CONFIG_CATEGORIES.find((c) => c.id === activeCategory) ?? CONFIG_CATEGORIES[0];
  const activeRows = groups[activeCategory];

  const dirtyRows = activeRows.filter((config) => !isReadOnly(config) && drafts[config.id] !== undefined && drafts[config.id] !== config.value);

  function selectCategory(id: CategoryId) {
    setSelectedId(id);
    void setCategoryParam(id === 'general' ? null : id);
  }

  function cancelCategory() {
    setDrafts((current) => {
      const next = { ...current };
      for (const config of dirtyRows) delete next[config.id];
      return next;
    });
    updateConfigs.reset();
  }

  async function saveCategory() {
    let saved = 0;
    for (const config of dirtyRows) {
      try {
        // Sequential per-row If-Match: the route folds the header version
        // onto every row, so one request per row keeps each row's own
        // version authoritative (AC 3).
        await updateConfigs.mutateAsync({
          updates: [{ id: config.id, value: drafts[config.id]!, expectedVersion: config.version }],
          etag: `"${config.version}"`,
        });
        setDrafts(({ [config.id]: _saved, ...rest }) => rest);
        saved += 1;
      } catch (error) {
        if (isOccError(error)) return; // Stop; OCC alert (mutation.error) drives the banner, drafts retained.
        toast.error(error instanceof GatewayError ? error.message : 'Could not update the setting.');
        return;
      }
    }
    if (saved > 0) toast.success(saved === 1 ? 'Setting updated' : `${saved} settings updated`);
  }

  if (configsQuery.isPending) return <SettingsSkeleton />;
  if (configsQuery.error || !configsQuery.data) {
    return <ErrorState error={configsQuery.error} onRetry={() => void configsQuery.refetch()} />;
  }
  if (configRows.length === 0) {
    return (
      <EmptyState
        icon={IconAdjustmentsHorizontal}
        title="No tenant settings"
        description="Platform defaults apply until a config row is created for this tenant."
      />
    );
  }

  const rail = CONFIG_CATEGORIES.map((category) => {
    const rows = groups[category.id];
    const allReadOnly = rows.length > 0 && rows.every(isReadOnly);
    const selected = category.id === activeCategory;
    return (
      <Button
        key={category.id}
        type="button"
        variant={selected ? 'secondary' : 'ghost'}
        size="sm"
        aria-current={selected ? 'true' : undefined}
        onClick={() => selectCategory(category.id)}
        className={cn('justify-start gap-2 whitespace-nowrap', tier !== 'mobile' && 'w-full')}
      >
        {allReadOnly ? <IconLock aria-hidden className="size-3.5" /> : null}
        <span className="min-w-0 truncate">{category.label}</span>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">{rows.length}</span>
      </Button>
    );
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <OccConflictAlert
        error={updateConfigs.error}
        onReload={() => {
          // Drafts stay in memory — re-saving applies them against the
          // freshly loaded row versions ("no silent loss").
          updateConfigs.reset();
          void configsQuery.refetch();
        }}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {tier === 'mobile' ? (
          <nav aria-label="Settings categories" className="-mx-1 flex shrink-0 snap-x gap-2 overflow-x-auto px-1 pb-1">
            {rail}
          </nav>
        ) : (
          <nav aria-label="Settings categories" className="flex flex-col gap-1 lg:w-55 lg:shrink-0 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            {rail}
          </nav>
        )}
        <section aria-labelledby={`${uid}-cat-heading`} className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto lg:pr-1">
          <div className="flex flex-col gap-1">
            <h3 id={`${uid}-cat-heading`} className="text-base font-medium">
              {activeMeta.label}
            </h3>
            <p className="text-muted-foreground text-sm">{activeMeta.description}</p>
          </div>
          {activeRows.length === 0 ? (
            <EmptyState
              icon={IconAdjustmentsHorizontal}
              title="Nothing here yet"
              description="No settings fall under this category for the current tenant."
            />
          ) : (
            <Card className="gap-0 divide-y p-0">
              {activeRows.map((config) => {
                const rowReadOnly = readOnly || isReadOnly(config);
                const draft = drafts[config.id];
                const controlId = `${uid}-${config.id || config.key}`;
                return (
                  <div key={config.id || config.key} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor={controlId} className="text-sm">
                          {config.name}
                        </Label>
                        {config.locked ? (
                          <Badge variant="outline">
                            <IconLock aria-hidden />
                            Platform-managed
                          </Badge>
                        ) : null}
                        {!config.id ? (
                          <Badge variant="outline">
                            <IconLock aria-hidden />
                            Read-only
                          </Badge>
                        ) : null}
                      </div>
                      <span className="text-muted-foreground font-mono text-xs">{config.key}</span>
                      {config.description ? <p className="text-muted-foreground text-xs">{config.description}</p> : null}
                      {config.id ? (
                        <p className="text-muted-foreground text-xs">
                          v{config.version} &middot; updated {formatRelativeTime(config.updatedAt)}
                        </p>
                      ) : (
                        <p className="text-muted-foreground text-xs">Platform-managed &middot; read-only</p>
                      )}
                    </div>
                    <div className="w-full shrink-0 sm:w-72" id={controlId}>
                      <ConfigControl
                        config={config}
                        value={draft ?? config.value}
                        disabled={rowReadOnly}
                        onChange={(value) => setDrafts((current) => ({ ...current, [config.id]: value }))}
                      />
                    </div>
                  </div>
                );
              })}
            </Card>
          )}
          {!readOnly && dirtyRows.length > 0 ? (
            <div className="bg-background sticky bottom-0 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-md border p-3">
              <span className="text-sm" role="status">
                {dirtyRows.length === 1 ? '1 unsaved change' : `${dirtyRows.length} unsaved changes`}
              </span>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled={updateConfigs.isPending} onClick={cancelCategory}>
                  Cancel
                </Button>
                <Button type="button" size="sm" disabled={updateConfigs.isPending} onClick={() => void saveCategory()}>
                  Save
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
