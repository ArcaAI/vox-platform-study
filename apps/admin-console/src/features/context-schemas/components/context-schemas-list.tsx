'use client';

/**
 * The Context Schemas list — `GET admin/consultation-context-schemas`
 * has no query filters (the controller reads only the caller's tenant off
 * CLS), so this fetches the whole tenant catalog in one page (admin scale),
 * mirroring the Agent Catalog's flat-list pattern.
 */

import { useState } from 'react';
import { IconPlus, IconSchema } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useContextSchemas, useDeleteContextSchema } from '../api/hooks';
import type { ConsultationContextSchema } from '../api/types';
import { ContextSchemaDetailDrawer } from './context-schema-detail-drawer';

function SchemaRow({ schema, onSelect }: { schema: ConsultationContextSchema; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="hover:bg-muted flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-left"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{schema.name}</span>
            <Badge variant="outline">{schema.status}</Badge>
            {schema.isDefault ? <Badge>Default</Badge> : null}
          </span>
          <span className="text-muted-foreground truncate font-mono text-xs">{schema.slug}</span>
        </span>
        <span className="text-muted-foreground shrink-0 font-mono text-xs">
          {schema.departmentId ? `DEPARTMENT` : 'TENANT'} &middot; {schema.pinnedVersionNumber != null ? `v${schema.pinnedVersionNumber}` : 'unpublished'}
        </span>
      </button>
    </li>
  );
}

function ContextSchemasListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </div>
  );
}

export function ContextSchemasList() {
  const [selectedParam, setSelectedParam] = useQueryState('schema', parseAsString.withDefault(''));
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ConsultationContextSchema | null>(null);

  const schemasQuery = useContextSchemas();
  const deleteSchema = useDeleteContextSchema();

  const schemas = schemasQuery.data ?? [];
  const selected = schemas.find((schema) => schema.id === selectedParam) ?? null;

  function handleDeleteConfirmed() {
    if (!deleting) return;
    deleteSchema.mutate(deleting.id, {
      onSuccess: () => {
        toast.success('Context schema deleted');
        if (deleting.id === selectedParam) void setSelectedParam(null);
        setDeleting(null);
      },
      onError: (error) => {
        toast.error(error instanceof GatewayError ? error.message : 'Could not delete the context schema.');
        setDeleting(null);
      },
    });
  }

  if (schemasQuery.isPending) return <ContextSchemasListSkeleton />;
  if (schemasQuery.error) return <ErrorState error={schemasQuery.error} onRetry={() => void schemasQuery.refetch()} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Context schemas ({schemas.length})</h2>
          <p className="text-muted-foreground text-sm">
            Each schema declares the kinds of context a consultation carries — pick a working kind vocabulary, publish it, and clients discover it at
            session open.
          </p>
        </div>
        {schemas.length > 0 ? (
          <Button onClick={() => setCreating(true)}>
            <IconPlus aria-hidden />
            New schema
          </Button>
        ) : null}
      </div>

      {schemas.length === 0 ? (
        <EmptyState
          icon={IconSchema}
          title="No context schemas yet"
          description="Create a schema, declare its kinds, and publish a version — clients discover it at GET /tenant/me/context-schema."
          action={
            <Button onClick={() => setCreating(true)}>
              <IconPlus aria-hidden />
              New schema
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {schemas.map((schema) => (
            <SchemaRow key={schema.id} schema={schema} onSelect={() => void setSelectedParam(schema.id)} />
          ))}
        </ul>
      )}

      <ContextSchemaDetailDrawer
        key={creating ? 'create' : selected?.id || 'no-schema'}
        schemaId={creating ? null : (selected?.id ?? null)}
        creating={creating}
        onOpenChange={(open) => {
          if (open) return;
          setCreating(false);
          void setSelectedParam(null);
        }}
        onCreated={(schema) => {
          setCreating(false);
          void setSelectedParam(schema.id);
        }}
        onRequestDelete={setDeleting}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete context schema?"
        description={deleting ? `Soft-deletes "${deleting.name}". Its published version history is kept — a ContextItem stamped with one must resolve it forever.` : ''}
        confirmLabel="Delete schema"
        destructive
        typeToConfirm={deleting?.name}
        onConfirm={handleDeleteConfirmed}
        isPending={deleteSchema.isPending}
      />
    </div>
  );
}
