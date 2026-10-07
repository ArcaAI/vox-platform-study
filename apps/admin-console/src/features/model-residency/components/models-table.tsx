'use client';

import { IconAlertTriangle, IconFilterOff } from '@tabler/icons-react';
import { parseAsArrayOf, parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { cn } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { Toggle } from '@arcaai/ui/components/shadcn/toggle';
import { EmptyState } from '@/shared/state/empty-state';
import type { ResidencyCatalogueModel, ResidencyDevice, ResidencyServiceGroup } from '../api/types';
import {
  formatKeepPolicy,
  formatStateWhere,
  formatTraffic,
  formatUsedBy,
  formatUsedByNote,
  isLivePathModel,
  isProblemModel,
  primaryRowActionLabel,
  rowActionFor,
  type StateTone,
} from './residency-display';

type RowHandler = (service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => void;

export interface ModelsTableProps {
  services: ResidencyServiceGroup[];
  devices: ResidencyDevice[];
  /** `service|modelRef` keys with a load operation still running (screen-tracked). */
  pendingKeys: ReadonlySet<string>;
  onLoad: RowHandler;
  onUnload: RowHandler;
  onLink: RowHandler;
  /** Details, and Reload… (the drawer owns the LM Studio profile editor). */
  onOpenDrawer: RowHandler;
}

const FILTERS = ['problems', 'live', 'loaded', 'resident'] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_PREDICATE: Record<Filter, (model: ResidencyCatalogueModel) => boolean> = {
  problems: isProblemModel,
  live: isLivePathModel,
  loaded: (model) => model.status === 'loaded',
  resident: (model) => model.kind === 'resident',
};

const FILTER_LABEL: Record<Filter, string> = {
  problems: 'Problems',
  live: 'Live path',
  loaded: 'Loaded',
  resident: 'Hide remote & built-in',
};

const COLUMN_COUNT = 6;
const ALL = 'all';

export function pendingKey(service: string, modelRef: string): string {
  return `${service}|${modelRef}`;
}

const TONE_CLASS: Record<StateTone, string> = {
  ok: 'border-success-strong/40 text-success-strong',
  warn: 'border-warning-strong/50 text-warning-strong',
  critical: 'border-destructive/50 text-destructive-strong',
  neutral: 'text-muted-foreground',
  busy: 'text-foreground',
};

function RowActions({
  service,
  model,
  pending,
  onLoad,
  onUnload,
  onLink,
  onOpenDrawer,
}: { service: ResidencyServiceGroup; model: ResidencyCatalogueModel; pending: boolean } & Omit<
  ModelsTableProps,
  'services' | 'devices' | 'pendingKeys'
>) {
  const action = rowActionFor(service, model);
  const busy = pending || model.status === 'loading' || model.status === 'unloading';
  const name = model.aiModelId ? model.name : model.modelRef;
  const busyId = `busy-${pendingKey(service.service, model.modelRef)}`.replace(/[^\w-]/g, '_');
  const solid = action === 'link' || (action === 'load' && model.keepPolicy.kind === 'always');
  const handler: Record<'load' | 'unload' | 'reload' | 'link', RowHandler> = { load: onLoad, unload: onUnload, reload: onOpenDrawer, link: onLink };

  return (
    <span className="flex items-center justify-end gap-2">
      {busy ? (
        <span id={busyId} role="status" className="text-muted-foreground text-xs">
          {model.status === 'unloading' ? 'Unload in progress' : 'Load in progress'}
        </span>
      ) : null}
      {action ? (
        <Button
          size="sm"
          variant={solid ? 'default' : 'outline'}
          disabled={pending}
          aria-describedby={pending ? busyId : undefined}
          onClick={() => handler[action](service, model)}
        >
          {primaryRowActionLabel(action)}
          <span className="sr-only"> {name}</span>
        </Button>
      ) : null}
      {/* A model outside the catalogue has no usage, no keep policy and nothing for the drawer to show. */}
      {model.aiModelId !== null ? (
        <Button size="sm" variant="ghost" onClick={() => onOpenDrawer(service, model)}>
          Details<span className="sr-only"> {name}</span>
        </Button>
      ) : null}
    </span>
  );
}

function ModelRow({
  service,
  model,
  devices,
  pending,
  ...handlers
}: { service: ResidencyServiceGroup; model: ResidencyCatalogueModel; devices: ResidencyDevice[]; pending: boolean } & Omit<
  ModelsTableProps,
  'services' | 'devices' | 'pendingKeys'
>) {
  const state = formatStateWhere(model, devices);
  const policy = formatKeepPolicy(model);
  const usedNote = formatUsedByNote(model.usage);
  return (
    <TableRow className={cn(isProblemModel(model) && 'bg-warning/5')}>
      <TableCell className="px-4 align-top whitespace-normal">
        <div className="flex flex-col">
          <span data-testid="model-name" className="font-medium break-words">
            {model.aiModelId ? model.name : model.modelRef}
          </span>
          {model.aiModelId ? (
            <span className="text-muted-foreground font-mono text-xs break-all">{model.slug}</span>
          ) : (
            <span className="text-muted-foreground text-xs">Not in the model catalogue</span>
          )}
        </div>
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <div className="flex flex-col items-start gap-1">
          <Badge variant={state.tone === 'busy' ? 'secondary' : 'outline'} className={TONE_CLASS[state.tone]}>
            {state.state}
          </Badge>
          <span className="text-muted-foreground text-xs">{state.where}</span>
        </div>
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <div className="flex flex-col">
          <span>{formatUsedBy(model.usage)}</span>
          {usedNote ? <span className="text-muted-foreground text-xs">{usedNote}</span> : null}
        </div>
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <div className="flex flex-col">
          <span>{policy.label}</span>
          <span className="text-muted-foreground text-xs">{policy.reason}</span>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground align-top whitespace-normal tabular-nums">{formatTraffic(model)}</TableCell>
      <TableCell className="px-4 align-top">
        <RowActions service={service} model={model} pending={pending} {...handlers} />
      </TableCell>
    </TableRow>
  );
}

function GroupHeader({ service }: { service: ResidencyServiceGroup }) {
  return (
    <TableRow className="bg-muted/40 hover:bg-muted/40">
      <th role="rowheader" scope="rowgroup" colSpan={COLUMN_COUNT} data-service={service.service} className="px-4 py-2 text-left font-normal">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-medium">{service.label}</span>
          <span className="text-muted-foreground text-xs">
            Runs on {service.runsOn === 'gpu' ? 'GPU' : 'CPU'} · {service.models.length} model{service.models.length === 1 ? '' : 's'} ·{' '}
            {service.loadedCount} loaded
          </span>
          {!service.controllable ? <Badge variant="outline">Read-only &middot; no control API</Badge> : null}
        </div>
        {!service.reachable ? (
          <div role="alert" className="border-destructive/40 bg-destructive/10 mt-2 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <IconAlertTriangle aria-hidden className="text-destructive size-4 shrink-0" />
            <span className="text-destructive">{service.label} did not answer. Its residency may be out of date.</span>
          </div>
        ) : null}
      </th>
    </TableRow>
  );
}

/**
 * Models (artboard 01): ONE table for every service, grouped by service with
 * a header row per group. Service tabs and filter chips live in the URL
 * (`?service=…&show=…`). The table scrolls horizontally inside its own box —
 * the page keeps a single vertical scroll container.
 */
export function ModelsTable({ services, devices, pendingKeys, ...handlers }: ModelsTableProps) {
  const [tabParam, setTab] = useQueryState('service', parseAsString.withDefault(ALL));
  const [show, setShow] = useQueryState('show', parseAsArrayOf(parseAsStringLiteral(FILTERS)).withDefault([]));

  const tab = tabParam === ALL || services.some((service) => service.service === tabParam) ? tabParam : ALL;
  const inTab = tab === ALL ? services : services.filter((service) => service.service === tab);
  const active = new Set<Filter>(show);
  const passes = (model: ResidencyCatalogueModel) => [...active].every((filter) => FILTER_PREDICATE[filter](model));

  const total = services.reduce((sum, service) => sum + service.models.length, 0);
  const tabModels = inTab.flatMap((service) => service.models);
  const groups = inTab
    .map((service) => ({ service, models: service.models.filter(passes) }))
    .filter((group) => active.size === 0 || group.models.length > 0);
  const filteredOut = active.size > 0 && groups.length === 0;

  function toggle(filter: Filter, pressed: boolean) {
    const next = FILTERS.filter((candidate) => (candidate === filter ? pressed : active.has(candidate)));
    void setShow(next.length > 0 ? next : null);
  }

  return (
    <Card role="region" aria-labelledby="residency-models-heading" className="gap-0 overflow-hidden p-0">
      <Tabs value={tab} onValueChange={(value) => void setTab(value === ALL ? null : value)} className="gap-0">
        <div className="flex flex-col gap-2 border-b px-4 pt-3">
          <h2 id="residency-models-heading" className="text-base font-medium">
            Models ({total})
          </h2>
          <div className="overflow-x-auto">
            <TabsList variant="line" aria-label="Service">
              <TabsTrigger value={ALL}>
                <span>All</span> <span className="text-muted-foreground tabular-nums">{total}</span>
              </TabsTrigger>
              {services.map((service) => (
                <TabsTrigger key={service.service} value={service.service}>
                  <span>{service.label}</span> <span className="text-muted-foreground tabular-nums">{service.models.length}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </div>
        <TabsContent value={tab}>
          <div role="group" aria-label="Filters" className="flex flex-wrap gap-2 px-4 py-3">
            {FILTERS.map((filter) => {
              const count = filter === 'resident' ? null : tabModels.filter(FILTER_PREDICATE[filter]).length;
              return (
                <Toggle
                  key={filter}
                  variant="outline"
                  size="sm"
                  pressed={active.has(filter)}
                  onPressedChange={(pressed) => toggle(filter, pressed)}
                  className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground h-8 rounded-full px-3 text-xs"
                >
                  {count === null ? (
                    FILTER_LABEL[filter]
                  ) : (
                    <>
                      <span>{FILTER_LABEL[filter]}</span> <span className="tabular-nums">{count}</span>
                    </>
                  )}
                </Toggle>
              );
            })}
          </div>
          {filteredOut ? (
            <div className="border-t p-4">
              <EmptyState
                icon={IconFilterOff}
                title="No models match these filters"
                action={
                  <Button variant="outline" size="sm" onClick={() => void setShow(null)}>
                    Clear filters
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="border-t">
              <Table aria-label="Models" className="min-w-[64rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="px-4">
                      Model
                    </TableHead>
                    <TableHead scope="col">State · where</TableHead>
                    <TableHead scope="col">Used by</TableHead>
                    <TableHead scope="col">Keep policy</TableHead>
                    <TableHead scope="col">Traffic</TableHead>
                    <TableHead scope="col" className="px-4 text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                {groups.map(({ service, models }) => (
                  <TableBody key={service.service}>
                    <GroupHeader service={service} />
                    {models.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={COLUMN_COUNT} className="text-muted-foreground px-4 py-3 text-sm">
                          No self-hosted models for this service
                        </TableCell>
                      </TableRow>
                    ) : (
                      models.map((model) => (
                        <ModelRow
                          key={`${service.service}::${model.modelRef}`}
                          service={service}
                          model={model}
                          devices={devices}
                          pending={pendingKeys.has(pendingKey(service.service, model.modelRef))}
                          {...handlers}
                        />
                      ))
                    )}
                  </TableBody>
                ))}
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </Card>
  );
}
