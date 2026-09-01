'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { IconBrain, IconExternalLink, IconSearch } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { SYSTEM_TENANT_ID } from '@/shared/catalog';
import { useCatalogueModels } from '../api/catalogue-client';

/**
 * MODEL CATALOGUE — `AiModel`, the set a provider configuration selects from.
 *
 * Read-only here, on purpose. `/ai-models` is the authoritative editor
 * (register, edit, live engine discovery, OCC writes), so this tab is the
 * read-only summary plus a plain-href deep link that rule 13 prescribes when
 * two surfaces would otherwise write the same rows. What it adds is CONTEXT:
 * the Providers tab points at model ids, and an administrator needs to see the
 * catalogue those ids come from without leaving the screen.
 */
export function CatalogueTab({ enabled }: { enabled: boolean }) {
  const [filter, setFilter] = useState('');
  const models = useCatalogueModels(enabled);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return models.data ?? [];
    return (models.data ?? []).filter((model) =>
      [model.slug, model.name, model.provider ?? '', model.taskType, model.format].some((field) => field.toLowerCase().includes(needle)),
    );
  }, [filter, models.data]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex w-full max-w-sm flex-col gap-1.5">
          <Label htmlFor="catalogue-filter">Filter catalogue</Label>
          <div className="relative">
            <IconSearch aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
            <Input
              id="catalogue-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="whisper, gguf, lm-studio…"
              className="pl-8"
            />
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/ai-models">
            Manage catalogue
            <IconExternalLink aria-hidden />
          </Link>
        </Button>
      </div>

      {models.isPending ? (
        <div className="flex flex-col gap-2 rounded-md border p-3" aria-hidden>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : models.error ? (
        <ErrorState error={models.error} onRetry={() => void models.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={IconBrain}
          title={filter ? 'No model matches this filter' : 'The catalogue is empty'}
          description={
            filter
              ? 'Clear the filter, or register the model on the catalogue screen.'
              : 'Provider configurations select from this catalogue, so an empty catalogue means nothing can be selected. Register a model to begin.'
          }
          action={
            <Button asChild size="sm">
              <Link href="/ai-models">Manage catalogue</Link>
            </Button>
          }
        />
      ) : (
        <div className="rounded-md border">
          <Table aria-label="Model catalogue">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Slug</TableHead>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Task</TableHead>
                <TableHead scope="col">Format</TableHead>
                <TableHead scope="col">Source</TableHead>
                <TableHead scope="col">Owner</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((model) => (
                <TableRow key={model.id}>
                  <TableCell className="font-mono text-xs">{model.slug}</TableCell>
                  <TableCell className="text-xs">{model.name}</TableCell>
                  <TableCell className="font-mono text-xs">{model.taskType}</TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="outline">{model.format}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="flex flex-col">
                      <Badge variant="secondary" className="self-start">
                        {model.source}
                      </Badge>
                      <span className="text-muted-foreground mt-1 font-mono break-all">{model.sourceUri}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {/* Which tier owns the row is what decides whether a tenant
                        is selecting its own model or the platform's. */}
                    <Badge variant={model.tenantId === SYSTEM_TENANT_ID ? 'secondary' : 'default'}>
                      {model.tenantId === SYSTEM_TENANT_ID ? 'Platform' : 'Tenant'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
