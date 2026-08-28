'use client';

/**
 * `DocumentTemplate` detail drawer — the console-wide `DetailDrawer` hosting
 * one template. Tabs: Settings (metadata OCC PATCH) → Shape (section editor +
 * publish) → Versions (history + pin).
 *
 * The Shape draft is lifted HERE rather than owned by `ShapeEditor` so that
 * switching tabs never discards in-progress editing, and so the re-seed rule
 * below has one place to live.
 */

import { useState } from 'react';
import { IconStar, IconTrash } from '@tabler/icons-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { ErrorState } from '@/shared/state/error-state';
import { useDocumentTemplate, useDocumentTemplateVersions } from '../api/hooks';
import { emptyShape, type DocumentTemplate, type DocumentTemplateShape, type DocumentTemplateVersion } from '../api/types';
import { CreateTemplateForm } from './create-template-form';
import { ShapeEditor } from './shape-editor';
import { TemplateSettingsForm } from './template-settings-form';
import { TemplateVersionsPanel } from './template-versions-panel';

type DocumentTemplateTab = 'settings' | 'shape' | 'versions';
const DOCUMENT_TEMPLATE_TABS = ['settings', 'shape', 'versions'] as const;

function useDocumentTemplateTab() {
  return useQueryState('dttab', parseAsStringLiteral(DOCUMENT_TEMPLATE_TABS).withDefault('shape'));
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function latestShape(versions: DocumentTemplateVersion[]): DocumentTemplateShape {
  if (versions.length === 0) return emptyShape();
  return [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0].shape;
}

export function DocumentTemplateDetailDrawer({
  templateId,
  creating,
  onOpenChange,
  onCreated,
  onRequestDelete,
}: {
  templateId: string | null;
  creating: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (template: DocumentTemplate) => void;
  onRequestDelete: (template: DocumentTemplate) => void;
}) {
  const open = creating || templateId !== null;
  const [tab, setTab] = useDocumentTemplateTab();
  const detail = useDocumentTemplate(templateId ?? '');
  const versionsQuery = useDocumentTemplateVersions(templateId ?? '');
  const template = templateId ? (detail.data?.data ?? null) : null;
  const etag = detail.data?.etag ?? null;
  const versions = versionsQuery.data ?? [];

  const [draft, setDraft] = useState<DocumentTemplateShape>(emptyShape());

  // Re-seed the draft from the latest published version once per (template,
  // first successful version load) — adjusted DURING RENDER (React's "adjusting
  // state when a prop changes" pattern) rather than in an effect, so it fires
  // exactly once per load. `versionsQuery.isSuccess` flips false -> true once
  // per template's query instance and stays true across background refetches,
  // so a refetch triggered by saving the Settings tab can never clobber
  // in-progress shape edits; only a genuine template switch reseeds.
  const seedKey = templateId && versionsQuery.isSuccess ? templateId : null;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seedKey && seedKey !== seededFor) {
    setSeededFor(seedKey);
    setDraft(latestShape(versions));
  }

  if (creating) {
    return (
      <DetailDrawer open={open} onOpenChange={onOpenChange} size="lg" title="New document template">
        <CreateTemplateForm onCreated={onCreated} onCancel={() => onOpenChange(false)} />
      </DetailDrawer>
    );
  }

  return (
    <Tabs value={tab} onValueChange={(next) => void setTab(next as DocumentTemplateTab)}>
      <DetailDrawer
        open={open}
        onOpenChange={onOpenChange}
        size="xl"
        title={template ? template.name : 'Document template'}
        badges={
          template ? (
            <>
              <Badge variant="outline">{template.status}</Badge>
              {template.isDefault ? (
                <Badge className="gap-1">
                  <IconStar aria-hidden className="size-3" />
                  Default
                </Badge>
              ) : null}
            </>
          ) : null
        }
        meta={
          template ? (
            <>
              <span className="font-mono">{template.id}</span>
              <CopyButton value={template.id} label="Copy template id" />
              <span aria-hidden>&middot;</span>
              <span className="font-mono">{template.slug}</span>
              <span aria-hidden>&middot;</span>
              <span>{template.pinnedVersionNumber != null ? `Pinned to v${template.pinnedVersionNumber}` : 'No published version'}</span>
            </>
          ) : null
        }
        tabs={
          template ? (
            <TabsList variant="line">
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="shape">Shape</TabsTrigger>
              <TabsTrigger value="versions">Versions ({versions.length})</TabsTrigger>
            </TabsList>
          ) : null
        }
        footer={
          template ? (
            <Button variant="destructive" size="sm" onClick={() => onRequestDelete(template)}>
              <IconTrash aria-hidden />
              Delete
            </Button>
          ) : null
        }
      >
        {!open ? null : detail.isPending ? (
          <DetailSkeleton />
        ) : detail.error || !template ? (
          <ErrorState
            error={detail.error ?? new GatewayError(404, 'This document template does not exist or is outside your access scope.')}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <>
            <TabsContent value="settings" className="mt-0">
              <TemplateSettingsForm
                key={`${template.id}-${template.updatedAt}`}
                template={template}
                etag={etag}
                onSaved={() => void detail.refetch()}
                onReload={() => void detail.refetch()}
              />
            </TabsContent>
            <TabsContent value="shape" className="mt-0">
              <ShapeEditor
                templateId={template.id}
                shape={draft}
                onShapeChange={setDraft}
                onPublished={() => {
                  void detail.refetch();
                  void versionsQuery.refetch();
                }}
              />
            </TabsContent>
            <TabsContent value="versions" className="mt-0">
              <TemplateVersionsPanel
                template={template}
                versions={versions}
                isPending={versionsQuery.isPending}
                error={versionsQuery.error}
                onRetry={() => void versionsQuery.refetch()}
                onChanged={() => {
                  void detail.refetch();
                  void versionsQuery.refetch();
                }}
              />
            </TabsContent>
          </>
        )}
      </DetailDrawer>
    </Tabs>
  );
}
