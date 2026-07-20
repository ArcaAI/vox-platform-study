'use client';

import { useState } from 'react';
import { IconFileSearch, IconAlertTriangle } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useConsultationReview } from '../api';
import type { ReviewClaim } from '../api/types';
import { buildTranscriptHighlights, hasSegmentProvenance } from '../lib/transcript-highlights';

/**
 * Consultation review — click-to-source evidence (TASK-533 B5, GAP-A2).
 *
 * The evidence-link machinery existed only in the deprecated `ui-playground`,
 * and had no data to work with anyway: `citationsMap.segmentId` was never
 * populated until D-22 fixed the transcript-segment producers. Both halves are
 * now real, so this brings the surface into the production console.
 *
 * The clinically load-bearing behaviour is the NEGATIVE case: a claim with no
 * resolved provenance must say so loudly. Silently showing an unhighlighted
 * transcript would read as "no evidence needed" rather than "evidence missing".
 */
export function ConsultationReviewScreen({ consultationId }: { consultationId: string }) {
    const reviewQuery = useConsultationReview(consultationId, true);
    const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);

    const review = reviewQuery.data;
    const selectedClaim: ReviewClaim | null = review?.claims.find((c) => c.id === selectedClaimId) ?? null;

    const header = (
        <PageHeader
            title="Consultation review"
            meta="Inspect the signed note against its source transcript. Select a claim to highlight the evidence it cites."
        />
    );

    if (reviewQuery.isPending) {
        return (
            <ScreenTemplate header={header}>
                <div className="grid gap-4 @3xl:grid-cols-2" aria-hidden>
                    {[0, 1].map((i) => (
                        <Card key={i}>
                            <CardHeader className="pb-2">
                                <Skeleton className="h-4 w-32" />
                            </CardHeader>
                            <CardContent className="flex flex-col gap-2">
                                <Skeleton className="h-4 w-full" />
                                <Skeleton className="h-4 w-5/6" />
                                <Skeleton className="h-4 w-3/4" />
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </ScreenTemplate>
        );
    }

    if (reviewQuery.error || !review) {
        return (
            <ScreenTemplate header={header}>
                <ErrorState error={reviewQuery.error} onRetry={() => void reviewQuery.refetch()} />
            </ScreenTemplate>
        );
    }

    if (review.claims.length === 0) {
        return (
            <ScreenTemplate header={header}>
                <EmptyState
                    icon={IconFileSearch}
                    title="No claims recorded"
                    description="This consultation has no citation map yet — it may predate evidence grounding, or the note has not been generated."
                />
            </ScreenTemplate>
        );
    }

    const selectedSpans = selectedClaim?.evidence ?? [];
    const selectedGrounded = selectedClaim ? hasSegmentProvenance(selectedSpans) : false;

    return (
        <ScreenTemplate header={header}>
            <div className="grid gap-4 @3xl:grid-cols-2">
                {/* Claims */}
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Claims ({review.claims.length})</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-1">
                        {review.claims.map((claim) => {
                            const grounded = hasSegmentProvenance(claim.evidence);
                            const isSelected = claim.id === selectedClaimId;
                            return (
                                <Button
                                    key={claim.id}
                                    variant={isSelected ? 'secondary' : 'ghost'}
                                    aria-pressed={isSelected}
                                    className="h-auto w-full justify-start whitespace-normal py-2 text-left"
                                    onClick={() => setSelectedClaimId(isSelected ? null : claim.id)}
                                >
                                    <span className="flex flex-col gap-1">
                                        <span className="text-sm">{claim.text}</span>
                                        <span className="flex flex-wrap items-center gap-1">
                                            {/* Never colour alone — the label states the state. */}
                                            <Badge variant={grounded ? 'secondary' : 'destructive'} className="text-[10px]">
                                                {grounded ? 'Evidence linked' : 'No source'}
                                            </Badge>
                                            {typeof claim.confidence === 'number' ? (
                                                <span className="text-muted-foreground font-mono text-[10px]">
                                                    confidence {claim.confidence.toFixed(2)}
                                                </span>
                                            ) : null}
                                        </span>
                                    </span>
                                </Button>
                            );
                        })}
                    </CardContent>
                </Card>

                {/* Transcript with evidence highlighting */}
                <Card data-testid="transcript-pane">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Transcript evidence</CardTitle>
                        <p className="text-muted-foreground text-xs">
                            {selectedClaim
                                ? selectedGrounded
                                    ? 'Highlighted spans are the transcript this claim cites.'
                                    : 'This claim cites no resolved transcript source.'
                                : 'Select a claim to see the transcript it cites.'}
                        </p>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                        {selectedClaim && !selectedGrounded ? (
                            // The load-bearing warning: absent provenance must never
                            // read as "no evidence needed".
                            <p role="alert" className="text-destructive flex items-start gap-2 text-xs">
                                <IconAlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                                No transcript source resolved for this claim — it could not be traced back to what was said.
                            </p>
                        ) : null}

                        {review.transcripts.map((transcript) => (
                            <div key={transcript.contextItemId} className="flex flex-col gap-1">
                                {transcript.label ? <span className="text-muted-foreground text-xs font-medium">{transcript.label}</span> : null}
                                <p className="text-sm leading-relaxed">
                                    {buildTranscriptHighlights(transcript.text, selectedSpans).map((segment, index) =>
                                        segment.highlighted ? (
                                            <mark
                                                key={index}
                                                data-highlight="true"
                                                className="rounded-sm bg-amber-200/80 px-0.5 text-amber-950 dark:bg-amber-400/30 dark:text-amber-50"
                                            >
                                                {segment.text}
                                            </mark>
                                        ) : (
                                            <span key={index}>{segment.text}</span>
                                        ),
                                    )}
                                </p>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </div>
        </ScreenTemplate>
    );
}
