'use client';

/**
 * Knowledge documents list — `GET admin/knowledge/documents`, offset
 * paginated. Follows `features/workflow-studio/components/definitions-list-screen.tsx`
 * closely (same `ScreenTemplate` + `VirtualizedDataGrid` shape, /
 * in the same program).
 */

import { useState } from 'react';
import { IconBook2, IconRefresh } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { knowledgeKeys, useArchiveKnowledgeDocument, useDeleteKnowledgeDocument, useKnowledgeDocuments } from '../api';
import type { KnowledgeDocument } from '../api/types';
import { KnowledgeDocumentDetailDrawer } from './knowledge-document-detail-drawer';
import { KnowledgeDocumentStatusBadge } from './knowledge-document-status-badge';

const PAGE_SIZE = 25;

export function KnowledgeDocumentsList() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<KnowledgeDocument | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeDocument | null>(null);

  const documentsQuery = useKnowledgeDocuments({ page, limit: PAGE_SIZE });
  const archiveDocument = useArchiveKnowledgeDocument();
  const deleteDocument = useDeleteKnowledgeDocument();

  const rows = documentsQuery.data?.data ?? [];

  const queryState: DataQueryState = { pagination: { mode: 'offset', page, limit: PAGE_SIZE }, sorting: [], filters: [], globalSearch: undefined };
  const setQueryState = (next: DataQueryState) => setPage(next.pagination.mode === 'offset' ? next.pagination.page : 0);

  function handleArchiveConfirmed() {
    if (!archiving) return;
    archiveDocument.mutate(archiving.id, {
      onSuccess: () => {
        toast.success(`"${archiving.title}" archived`);
        setArchiving(null);
      },
      onError: (error) => {
        toast.error(error instanceof GatewayError ? error.message : 'Could not archive the document.');
        setArchiving(null);
      },
    });
  }

  function handleDeleteConfirmed() {
    if (!deleting) return;
    deleteDocument.mutate(deleting.id, {
      onSuccess: () => {
        toast.success(`"${deleting.title}" deleted — its vectors were removed from Qdrant`);
        if (deleting.id === selectedId) setSelectedId(null);
        setDeleting(null);
      },
      onError: (error) => {
        // Fail-closed server-side: a failure here means NOTHING was deleted.
        toast.error(
          error instanceof GatewayError ? error.message : 'Could not delete the document — its vectors could not be confirmed removed, so nothing was changed.',
        );
        setDeleting(null);
      },
    });
  }

  const columns: ColumnDef<KnowledgeDocument>[] = [
    {
      accessorKey: 'title',
      header: 'Title',
      meta: { label: 'Title' },
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="truncate font-medium">{row.original.title}</span>
          <span className="text-muted-foreground truncate font-mono text-xs">{row.original.source}</span>
        </div>
      ),
    },
    { accessorKey: 'status', header: 'Status', meta: { label: 'Status' }, cell: ({ row }) => <KnowledgeDocumentStatusBadge status={row.original.status} /> },
    { accessorKey: 'chunkCount', header: 'Chunks', meta: { label: 'Chunks' } },
    {
      accessorKey: 'updatedAt',
      header: 'Updated',
      meta: { label: 'Updated' },
      cell: ({ row }) => (
        <span className="whitespace-nowrap" title={row.original.updatedAt}>
          {formatRelativeTime(row.original.updatedAt)}
        </span>
      ),
    },
  ];

  return (
    <ScreenTemplate
      contentMode="fill"
      header={
        <PageHeader
          title="Knowledge Base"
          meta={<span>Institutional documents grounding this tenant&apos;s summary generation with citations.</span>}
          actions={
            <Button variant="outline" onClick={() => void queryClient.invalidateQueries({ queryKey: knowledgeKeys.root })}>
              <IconRefresh aria-hidden />
              Refresh
            </Button>
          }
        />
      }
      footer={
        <StatusFooter
          start={<span>Archive/delete are manual governance actions — nothing expires automatically yet.</span>}
          end={
            <span aria-hidden className="font-mono">
              GET /admin/knowledge/documents
            </span>
          }
        />
      }
    >
      <VirtualizedDataGrid<KnowledgeDocument>
        aria-label="Knowledge documents"
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        persistence={gridPersistence('knowledge-documents')}
        manual={{ pagination: true }}
        rowCount={documentsQuery.data?.count ?? 0}
        pageMode="offset"
        queryState={queryState}
        onQueryStateChange={setQueryState}
        features={{
          columnReorder: true,
          columnResize: true,
          columnPinning: true,
          columnVisibility: true,
          rowSelection: false,
          globalSearch: false,
          facetedFilters: false,
          sorting: false,
        }}
        isLoading={documentsQuery.isLoading}
        isBusy={documentsQuery.isFetching && !documentsQuery.isLoading}
        error={documentsQuery.error}
        onRetry={() => void documentsQuery.refetch()}
        errorState={(err) => <ErrorState error={err} onRetry={() => void documentsQuery.refetch()} />}
        emptyState={
          <EmptyState
            icon={IconBook2}
            title="No knowledge documents yet"
            description="Documents appear here once an admin registers and approves a source document for the institutional-RAG corpus."
          />
        }
        onRowClick={(row) => setSelectedId(row.id)}
      />

      <KnowledgeDocumentDetailDrawer
        documentId={selectedId}
        onOpenChange={(open) => !open && setSelectedId(null)}
        onRequestArchive={setArchiving}
        onRequestDelete={setDeleting}
      />

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title="Archive knowledge document?"
        description={archiving ? `"${archiving.title}" stays listed and its chunks/vectors are untouched — archiving is a soft governance action, not a delete.` : ''}
        confirmLabel="Archive document"
        onConfirm={handleArchiveConfirmed}
        isPending={archiveDocument.isPending}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete knowledge document?"
        description={
          deleting
            ? `Soft-deletes "${deleting.title}" AND removes its vectors from Qdrant. Fail-closed: if the vector cleanup cannot be confirmed, nothing is deleted.`
            : ''
        }
        confirmLabel="Delete document"
        destructive
        typeToConfirm={deleting?.title}
        onConfirm={handleDeleteConfirmed}
        isPending={deleteDocument.isPending}
      />
    </ScreenTemplate>
  );
}
