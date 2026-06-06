import { Main } from '@/components/layout/main';
import { Badge } from '@arcaai/ui/badge';
import type { SummaryApprovalResponse } from '@arcaai/vox';
import { useCallback } from 'react';
import { approveReviewedNote } from '../api/approve-note';
import { ReviewScreen } from '../components';
import { SAMPLE_REVIEW } from '../fixtures/sample-review';

export default function ClinicalReviewPage() {
  const handleApprove = useCallback(
    (noteContextItemId: string): Promise<SummaryApprovalResponse> =>
      approveReviewedNote({ consultationId: SAMPLE_REVIEW.consultationId, noteContextItemId }),
    [],
  );

  return (
    <Main>
      <div className="mb-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Clinician Review</h1>
            <p className="text-muted-foreground mt-1 max-w-2xl">
              Review the AI-drafted SOAP note with linked transcript evidence. Unverified and flagged claims float to the top — select any claim to
              highlight the transcript spans it was grounded in, then approve to sign.
            </p>
          </div>
          <Badge variant="secondary" className="shrink-0" title="Rendered from a local fixture matching the SummaryMeta.citationsMap contract">
            Fixture data
          </Badge>
        </div>
      </div>
      <ReviewScreen data={SAMPLE_REVIEW} onApprove={handleApprove} />
    </Main>
  );
}
