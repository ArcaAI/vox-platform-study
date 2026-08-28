'use client';

/**
 * The document-template catalog. `GET admin/document-templates` has no query
 * filters (the controller reads only the caller's tenant off CLS), so this
 * fetches the whole tenant catalog in one page — admin scale, the same flat-list
 * pattern as the context-schema catalog.
 */

import { useState } from 'react';
import { IconFileText, IconPlus } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useDeleteDocumentTemplate, useDocumentTemplates } from '../api/hooks';
import type { DocumentTemplate } from '../api/types';
import { effectiveTemplate } from '../lib/effective-template';
import { DocumentTemplateDetailDrawer } from './document-template-detail-drawer';
import { EffectiveTemplateBanner } from './effective-template-banner';

function TemplateRow({ template, onSelect }: { template: DocumentTemplate; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="hover:bg-muted flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-left"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{template.name}</span>
            <Badge variant="outline">{template.status}</Badge>
            {template.isDefault ? <Badge>Default</Badge> : null}
          </span>
          <span className="text-muted-foreground truncate font-mono text-xs">{template.slug}</span>
        </span>
        <span className="text-muted-foreground shrink-0 font-mono text-xs">
          {template.pinnedVersionNumber != null ? `v${template.pinnedVersionNumber}` : 'unpublished'}
        </span>
      </button>
    </li>
  );
}

function DocumentTemplatesListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      <Skeleton className="h-20 w-full" />
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </div>
  );
}

export function DocumentTemplatesList() {
  const [selectedParam, setSelectedParam] = useQueryState('template', parseAsString.withDefault(''));
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<DocumentTemplate | null>(null);

  const templatesQuery = useDocumentTemplates();
  const deleteTemplate = useDeleteDocumentTemplate();

  const templates = templatesQuery.data ?? [];
  const selected = templates.find((template) => template.id === selectedParam) ?? null;

  function handleDeleteConfirmed() {
    if (!deleting) return;
    deleteTemplate.mutate(deleting.id, {
      onSuccess: () => {
        toast.success('Document template deleted');
        if (deleting.id === selectedParam) void setSelectedParam(null);
        setDeleting(null);
      },
      onError: (error) => {
        toast.error(error instanceof GatewayError ? error.message : 'Could not delete the document template.');
        setDeleting(null);
      },
    });
  }

  if (templatesQuery.isPending) return <DocumentTemplatesListSkeleton />;
  if (templatesQuery.error) return <ErrorState error={templatesQuery.error} onRetry={() => void templatesQuery.refetch()} />;

  const effective = effectiveTemplate(templates);

  return (
    <div className="flex flex-col gap-4">
      <EffectiveTemplateBanner effective={effective} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">Document templates ({templates.length})</h2>
          <p className="text-muted-foreground text-sm">
            A template is the SHAPE of a document a generation node produces — which sections exist, in which order, what form each takes, and which may
            legitimately be left empty. Publishing compiles that shape into the schema the model is decoded against.
          </p>
        </div>
        {templates.length > 0 ? (
          <Button onClick={() => setCreating(true)}>
            <IconPlus aria-hidden />
            New template
          </Button>
        ) : null}
      </div>

      {templates.length === 0 ? (
        <EmptyState
          icon={IconFileText}
          title="No document templates yet"
          description="Create one, declare its sections, and publish a version. Until then generation keeps working against the platform SOAP shape — nothing is broken, but nothing is yours either."
          action={
            <Button onClick={() => setCreating(true)}>
              <IconPlus aria-hidden />
              New template
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {templates.map((template) => (
            <TemplateRow key={template.id} template={template} onSelect={() => void setSelectedParam(template.id)} />
          ))}
        </ul>
      )}

      <DocumentTemplateDetailDrawer
        key={creating ? 'create' : selected?.id || 'no-template'}
        templateId={creating ? null : (selected?.id ?? null)}
        creating={creating}
        onOpenChange={(open) => {
          if (open) return;
          setCreating(false);
          void setSelectedParam(null);
        }}
        onCreated={(template) => {
          setCreating(false);
          void setSelectedParam(template.id);
        }}
        onRequestDelete={setDeleting}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete document template?"
        description={
          deleting
            ? `Soft-deletes "${deleting.name}". Its published versions are kept — a document generated against one must resolve it forever.`
            : ''
        }
        confirmLabel="Delete template"
        destructive
        typeToConfirm={deleting?.name}
        onConfirm={handleDeleteConfirmed}
        isPending={deleteTemplate.isPending}
      />
    </div>
  );
}
