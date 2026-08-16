'use client';

/**
 * Chunks tab — paginated, decrypted chunk content for one document
 * (`GET :id/chunks`, force-audited server-side). Ordered by `chunkIndex`.
 * Card list rather than a data grid: this is a bounded per-document reading
 * view inside a detail-drawer tab, not a cross-document management surface.
 */

import { useState } from 'react';
import { IconFileText } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useKnowledgeChunks } from '../api/hooks';
import { KnowledgeChunkText } from './knowledge-chunk-text';

const PAGE_SIZE = 10;

function ChunksSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-24 w-full" />
      ))}
    </div>
  );
}

export function KnowledgeChunksPanel({ documentId }: { documentId: string }) {
  const [page, setPage] = useState(0);
  const chunksQuery = useKnowledgeChunks(documentId, { page, limit: PAGE_SIZE });

  if (chunksQuery.isPending) return <ChunksSkeleton />;
  if (chunksQuery.error) return <ErrorState error={chunksQuery.error} onRetry={() => void chunksQuery.refetch()} />;

  const chunks = chunksQuery.data?.data ?? [];
  const count = chunksQuery.data?.count ?? 0;

  if (chunks.length === 0) {
    return (
      <EmptyState
        icon={IconFileText}
        title="No chunks yet"
        description="Chunks appear once an APPROVED document's harness ingest job completes (chunk + embed + Qdrant upsert)."
      />
    );
  }

  const hasPrev = page > 0;
  const hasNext = (page + 1) * PAGE_SIZE < count;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        {count} chunk{count === 1 ? '' : 's'} — every read of this tab is written to the audit log.
      </p>
      <ul className="flex flex-col gap-2">
        {chunks.map((chunk) => (
          <li key={chunk.id}>
            <Card className="flex-col gap-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs font-medium">Chunk #{chunk.chunkIndex}</span>
                <span className="text-muted-foreground font-mono text-xs">
                  {chunk.tokenCount} tokens &middot; {chunk.embeddingModel}
                </span>
              </div>
              <KnowledgeChunkText text={chunk.text} />
            </Card>
          </li>
        ))}
      </ul>
      {count > PAGE_SIZE ? (
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="sm" disabled={!hasPrev} onClick={() => setPage((prev) => Math.max(0, prev - 1))}>
            Previous
          </Button>
          <span className="text-muted-foreground text-xs">
            Page {page + 1} of {Math.max(1, Math.ceil(count / PAGE_SIZE))}
          </span>
          <Button variant="outline" size="sm" disabled={!hasNext} onClick={() => setPage((prev) => prev + 1)}>
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
