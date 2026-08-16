'use client';

/**
 * `KnowledgeDocument` detail drawer — the console-wide `DetailDrawer`
 * hosting one document. Tabs: Overview (metadata) → Chunks (paginated,
 * decrypted, force-audited content). Archive/delete actions live in the
 * footer; both confirm (rule 11 §5 — destructive actions require
 * confirmation), delete additionally types-to-confirm the title since it
 * also removes the document's Qdrant vectors (fail-closed server-side).
 */

import type { ReactNode } from 'react';
import { IconArchive, IconTrash } from '@tabler/icons-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { ErrorState } from '@/shared/state/error-state';
import { useKnowledgeDocument } from '../api/hooks';
import { KnowledgeChunksPanel } from './knowledge-chunks-panel';
import { KnowledgeDocumentStatusBadge } from './knowledge-document-status-badge';
import type { KnowledgeDocument } from '../api/types';

type KnowledgeDocumentTab = 'overview' | 'chunks';
const KNOWLEDGE_DOCUMENT_TABS = ['overview', 'chunks'] as const;

function useKnowledgeDocumentTab() {
  return useQueryState('kdtab', parseAsStringLiteral(KNOWLEDGE_DOCUMENT_TABS).withDefault('overview'));
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

function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

function OverviewTab({ document }: { document: KnowledgeDocument }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <MetaRow label="Source" value={<span className="font-mono break-all">{document.source}</span>} />
      <MetaRow label="Source type" value={document.sourceType} />
      <MetaRow label="MIME type" value={<span className="font-mono">{document.mimeType}</span>} />
      <MetaRow label="Checksum" value={<span className="font-mono break-all">{document.checksum}</span>} />
      <MetaRow label="Chunk count" value={document.chunkCount} />
      <MetaRow label="Ingested" value={document.ingestedAt ? new Date(document.ingestedAt).toLocaleString() : 'Not yet ingested'} />
      <MetaRow label="Approved by" value={document.approvedBy ?? '—'} />
      <MetaRow label="Approved at" value={document.approvedAt ? new Date(document.approvedAt).toLocaleString() : '—'} />
      <MetaRow label="Created" value={new Date(document.createdAt).toLocaleString()} />
      <MetaRow label="Updated" value={new Date(document.updatedAt).toLocaleString()} />
    </div>
  );
}

export function KnowledgeDocumentDetailDrawer({
  documentId,
  onOpenChange,
  onRequestArchive,
  onRequestDelete,
}: {
  documentId: string | null;
  onOpenChange: (open: boolean) => void;
  onRequestArchive: (document: KnowledgeDocument) => void;
  onRequestDelete: (document: KnowledgeDocument) => void;
}) {
  const open = documentId !== null;
  const [tab, setTab] = useKnowledgeDocumentTab();
  const detail = useKnowledgeDocument(documentId ?? '');
  const document = detail.data ?? null;

  return (
    <Tabs value={tab} onValueChange={(next) => void setTab(next as KnowledgeDocumentTab)}>
      <DetailDrawer
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={document ? document.title : 'Knowledge document'}
        badges={document ? <KnowledgeDocumentStatusBadge status={document.status} /> : null}
        meta={
          document ? (
            <>
              <span className="font-mono">{document.id}</span>
              <CopyButton value={document.id} label="Copy document id" />
            </>
          ) : null
        }
        tabs={
          document ? (
            <TabsList variant="line">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="chunks">Chunks ({document.chunkCount})</TabsTrigger>
            </TabsList>
          ) : null
        }
        footer={
          document ? (
            <div className="flex items-center gap-2">
              {document.status !== 'ARCHIVED' ? (
                <Button variant="outline" size="sm" onClick={() => onRequestArchive(document)}>
                  <IconArchive aria-hidden />
                  Archive
                </Button>
              ) : null}
              <Button variant="destructive" size="sm" onClick={() => onRequestDelete(document)}>
                <IconTrash aria-hidden />
                Delete
              </Button>
            </div>
          ) : null
        }
      >
        {!open ? null : detail.isPending ? (
          <DetailSkeleton />
        ) : detail.error || !document ? (
          <ErrorState
            error={detail.error ?? new GatewayError(404, 'This knowledge document does not exist or is outside your access scope.')}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <>
            <TabsContent value="overview" className="mt-0">
              <OverviewTab document={document} />
            </TabsContent>
            <TabsContent value="chunks" className="mt-0">
              <KnowledgeChunksPanel documentId={document.id} />
            </TabsContent>
          </>
        )}
      </DetailDrawer>
    </Tabs>
  );
}
