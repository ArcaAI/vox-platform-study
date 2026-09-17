'use client';

/**
 * The Context Schemas list — `GET admin/consultation-context-schemas`
 * has no query filters (the controller reads only the caller's tenant off
 * CLS), so this fetches the whole tenant catalog in one page (admin scale),
 * mirroring the Agent Catalog's flat-list pattern.
 *
 * A row is a LINK to `/context-schemas/[id]`, not a button that opens a drawer:
 * a schema's detail is a page an admin works in, so it should be addressable,
 * bookmarkable, and reachable with the browser's own back button. Create still
 * opens a dialog — creating one is four fields, and the new schema's page is
 * where the work actually starts.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { IconPlus, IconSchema } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useContextSchemas } from '../api/hooks';
import type { ConsultationContextSchema } from '../api/types';
import { CreateSchemaForm } from './create-schema-form';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';

function SchemaRow({ schema }: { schema: ConsultationContextSchema }) {
  return (
    <li>
      <Link
        href={`/context-schemas/${encodeURIComponent(schema.id)}`}
        className="hover:bg-muted flex w-full flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-left"
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
          {schema.departmentId ? `DEPARTMENT` : 'TENANT'} &middot;{' '}
          {schema.pinnedVersionNumber != null ? `v${schema.pinnedVersionNumber}` : 'unpublished'}
        </span>
      </Link>
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
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const schemasQuery = useContextSchemas();
  const schemas = schemasQuery.data ?? [];

  if (schemasQuery.isPending) return <ContextSchemasListSkeleton />;
  if (schemasQuery.error) return <ErrorState error={schemasQuery.error} onRetry={() => void schemasQuery.refetch()} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">Context schemas ({schemas.length})</h2>
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
          description="Create a schema, declare its kinds, and publish a version — clients discover it at GET /tenants/me/context-schema."
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
            <SchemaRow key={schema.id} schema={schema} />
          ))}
        </ul>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className={DIALOG_SIZE_CLASS.md}>
          <DialogHeader>
            <DialogTitle>New context schema</DialogTitle>
            <DialogDescription>
              Name it and choose its scope. Kinds are declared on the schema&apos;s own page, then published as a version.
            </DialogDescription>
          </DialogHeader>
          <CreateSchemaForm
            onCreated={(schema) => {
              setCreating(false);
              router.push(`/context-schemas/${encodeURIComponent(schema.id)}`);
            }}
            onCancel={() => setCreating(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
