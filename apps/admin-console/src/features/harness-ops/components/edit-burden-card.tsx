'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconSearch, IconTimelineEventText } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { formatDateTime, formatNumber, formatPercent } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useEditBurden } from '../api';
import { formatDuration } from './format-duration';

const EM_DASH = '\u2014';

/** Fractions on the DTO (0.18) render as percentages; `formatPercent` takes 0-100. */
function ratio(value: number | null): string {
    return value === null ? EM_DASH : formatPercent(value * 100);
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <li className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground text-sm">
                {label}
                {hint ? <span className="text-muted-foreground/70 block text-xs">{hint}</span> : null}
            </span>
            <span className="text-sm font-medium tabular-nums">{value}</span>
        </li>
    );
}

/**
 * Clinician edit-burden telemetry for ONE
 * consultation. The endpoint composes over already-persisted WORM audit rows +
 * summary versions and returns DERIVED SCALARS only: the note text never leaves
 * the service, so there is nothing clinical to render here.
 *
 * A 404 means the consultation is absent OR belongs to another tenant (the
 * 404-over-403 posture) — an expected "nothing recorded" outcome, so it renders
 * an EmptyState rather than an error. A zeroed-but-present 200 is real data.
 */
export function EditBurdenCard() {
    const fieldId = useId();
    const [draft, setDraft] = useState('');
    const [consultationId, setConsultationId] = useState<string | null>(null);
    const burdenQuery = useEditBurden(consultationId);
    const burden = burdenQuery.data;
    const notFound = burdenQuery.error instanceof GatewayError && burdenQuery.error.isNotFound;

    function submit(event: FormEvent) {
        event.preventDefault();
        setConsultationId(draft.trim() || null);
    }

    return (
        <Card className="gap-3 py-4">
            <CardHeader className="gap-1 px-4">
                <h2 className="text-sm font-medium">Edit burden</h2>
                <span aria-hidden className="text-muted-foreground font-mono text-xs">
                    GET edit-burden?consultationId= {'\u00b7'} derived scalars only
                </span>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-4">
                <form onSubmit={submit} className="flex flex-col gap-1.5">
                    <Label htmlFor={fieldId}>Consultation ID</Label>
                    <div className="flex items-center gap-2">
                        <Input
                            id={fieldId}
                            aria-label="Consultation ID"
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            placeholder={'cons-\u2026'}
                            className="font-mono"
                        />
                        <Button type="submit" variant="outline" disabled={!draft.trim()}>
                            <IconSearch aria-hidden />
                            Look up
                        </Button>
                    </div>
                </form>

                {!consultationId ? (
                    <EmptyState
                        icon={IconTimelineEventText}
                        title="Look up a consultation"
                        description="Edit distance, deferral rate and time-to-sign are derived per consultation."
                    />
                ) : burdenQuery.isLoading ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-5/6" />
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-4 w-3/4" />
                    </div>
                ) : notFound ? (
                    <EmptyState
                        icon={IconTimelineEventText}
                        title="No edit-burden telemetry"
                        description="Nothing is recorded for this consultation, or it belongs to another tenant."
                    />
                ) : burdenQuery.error ? (
                    <ErrorState error={burdenQuery.error} onRetry={() => void burdenQuery.refetch()} />
                ) : burden ? (
                    <>
                        <ul className="flex flex-col gap-1.5" aria-label="Edit burden">
                            <Stat
                                label="Edit distance"
                                hint={'delivered \u2192 signed, words'}
                                value={burden.editDistance === null ? EM_DASH : formatNumber(burden.editDistance)}
                            />
                            <Stat label="Edit ratio" value={ratio(burden.editDistanceRatio)} />
                            <Stat label="Deferral rate" hint={`${formatNumber(burden.deferralCount)} of ${formatNumber(burden.gateDecisionTotal)} gate decisions`} value={ratio(burden.deferralRate)} />
                            <Stat label="Time to sign" value={burden.timeToSignSeconds === null ? EM_DASH : formatDuration(burden.timeToSignSeconds)} />
                        </ul>
                        <p className="text-muted-foreground text-xs">
                            Delivered {formatDateTime(burden.deliveredAt)} {'\u00b7'} signed {formatDateTime(burden.signedAt)}
                        </p>
                    </>
                ) : null}
            </CardContent>
        </Card>
    );
}
