'use client';

import { ErrorState } from '@/shared/state/error-state';
import { useNlpStatus } from '../api';
import { DocumentCard, DocumentSkeleton, UpstreamDocument } from './guardrail-panel';

/**
 * NLP tab: the service's per-model health document.
 *
 * ⚠ Like the guardrail documents, this shape is UPSTREAM-OWNED (proxied
 * verbatim from the NLP service's `GET /api/v1/health`), so it goes through
 * the same defensive `UpstreamDocument` renderer — status-ish fields become
 * badges, everything else degrades to readable key/value. See the header
 * comment in `guardrail-panel.tsx` before changing anything here.
 */
export function NlpPanel() {
    const statusQuery = useNlpStatus();

    if (statusQuery.isPending) {
        return (
            <DocumentCard title="NLP service status">
                <DocumentSkeleton rows={5} />
            </DocumentCard>
        );
    }

    if (statusQuery.error || !statusQuery.data) {
        return <ErrorState title="Couldn’t load the NLP status" error={statusQuery.error} onRetry={() => void statusQuery.refetch()} />;
    }

    return (
        <DocumentCard
            title="NLP service status"
            description="Proxied verbatim from the NLP service (GET /api/v1/health). Per-model component checks with load status."
        >
            <UpstreamDocument document={statusQuery.data} />
        </DocumentCard>
    );
}
