'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconArrowRight, IconClipboardList } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { RequirePermission } from '@/shared/auth/require-permission';
import { formatDateTime, formatPercent } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useCreateGoldenCase, useGateEditExemplars, useGoldenSets } from '../api';
import type { GateEditCorpusCandidate } from '../api';

const PAGE_LIMIT = 20;

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

function qualitySignalVariant(signal: string): 'default' | 'outline' {
    return signal === 'APPROVED_CLEAN' ? 'default' : 'outline';
}

/**
 * Promote-to-golden-case dialog (GAP-A1): pre-fills the golden-set "Add case"
 * write from a redacted gate-edit candidate. The admin picks a target set and
 * reviews/edits both fields before submitting — the source candidate is a
 * PROPOSAL (`reviewStatus: PENDING_SME_REVIEW`), never auto-admitted.
 *
 * Keyed by the CALLER on `candidate?.id` (like the console-wide detail-drawer
 * create/select convention) so a new candidate always seeds a fresh instance
 * — no manual "did the prop change" tracking needed.
 */
function PromoteToGoldenCaseDialog({
    candidate,
    onOpenChange,
}: {
    candidate: GateEditCorpusCandidate | null;
    onOpenChange: (open: boolean) => void;
}) {
    const fieldId = useId();
    const goldenSetsQuery = useGoldenSets({ limit: 200 });
    const goldenSets = goldenSetsQuery.data?.items ?? [];
    const [goldenSetId, setGoldenSetId] = useState('');
    const [transcript, setTranscript] = useState(candidate?.redactedBefore ?? '');
    const [referenceNote, setReferenceNote] = useState(candidate?.redactedAfter ?? '');
    const [label, setLabel] = useState(candidate ? `gate-edit-${candidate.id.slice(0, 8)}` : '');
    const createCase = useCreateGoldenCase(goldenSetId || null);

    function submit(event: FormEvent) {
        event.preventDefault();
        if (!goldenSetId) return;
        createCase.mutate(
            { transcript, referenceNote, label: label.trim() || undefined },
            {
                onSuccess: () => {
                    toast.success('Promoted to a draft golden case');
                    onOpenChange(false);
                },
                onError: (error) => toast.error(errorMessage(error, 'Could not create the golden case')),
            },
        );
    }

    return (
        <Dialog open={!!candidate} onOpenChange={onOpenChange}>
            <DialogContent className="flex h-[70vh] flex-col sm:max-w-[70vw]">
                <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
                    <DialogHeader className="shrink-0">
                        <DialogTitle>Promote to golden case</DialogTitle>
                        <DialogDescription>
                            Copies this redacted exemplar into a draft case — review and edit before saving; nothing is created
                            until you submit.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex min-h-0 flex-1 flex-col gap-3">
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`${fieldId}-set`}>Target golden set *</Label>
                            <NativeSelect
                                id={`${fieldId}-set`}
                                aria-label="Target golden set"
                                value={goldenSetId}
                                onChange={(event) => setGoldenSetId(event.target.value)}
                                required
                            >
                                <NativeSelectOption value="">Select a golden set…</NativeSelectOption>
                                {goldenSets.map((set) => (
                                    <NativeSelectOption key={set.id} value={set.id}>
                                        {set.name}
                                    </NativeSelectOption>
                                ))}
                            </NativeSelect>
                        </div>
                        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
                            <Label htmlFor={`${fieldId}-transcript`}>Transcript *</Label>
                            <Textarea
                                id={`${fieldId}-transcript`}
                                aria-label="Transcript"
                                value={transcript}
                                onChange={(event) => setTranscript(event.target.value)}
                                className="min-h-0 flex-1 resize-none"
                                required
                            />
                        </div>
                        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
                            <Label htmlFor={`${fieldId}-reference`}>Reference note *</Label>
                            <Textarea
                                id={`${fieldId}-reference`}
                                aria-label="Reference note"
                                value={referenceNote}
                                onChange={(event) => setReferenceNote(event.target.value)}
                                className="min-h-0 flex-1 resize-none"
                                required
                            />
                        </div>
                        <div className="flex shrink-0 flex-col gap-1.5">
                            <Label htmlFor={`${fieldId}-label`}>Label</Label>
                            <Input
                                id={`${fieldId}-label`}
                                aria-label="Label"
                                value={label}
                                onChange={(event) => setLabel(event.target.value)}
                                maxLength={200}
                            />
                        </div>
                    </div>
                    <DialogFooter className="shrink-0">
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!goldenSetId || !transcript || !referenceNote || createCase.isPending}>
                            {createCase.isPending ? <Spinner aria-hidden /> : null}
                            Save draft case
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function CandidateRow({ candidate, onPromote }: { candidate: GateEditCorpusCandidate; onPromote: () => void }) {
    return (
        <li className="flex flex-col gap-2 rounded-md border px-2.5 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2">
                    <Badge variant={qualitySignalVariant(candidate.qualitySignal)}>{candidate.qualitySignal}</Badge>
                    {candidate.departmentId ? <span className="text-muted-foreground font-mono text-xs">{candidate.departmentId}</span> : null}
                    {candidate.editDistanceRatio !== null ? (
                        <span className="text-muted-foreground text-xs">{formatPercent(candidate.editDistanceRatio * 100)} edited</span>
                    ) : null}
                </span>
                <RequirePermission action="manage" subject="HarnessEval">
                    <Button size="sm" variant="outline" onClick={onPromote}>
                        <IconArrowRight aria-hidden />
                        Promote to golden case
                    </Button>
                </RequirePermission>
            </div>
            {candidate.redactedAfter ? <p className="text-muted-foreground line-clamp-2 text-xs">{candidate.redactedAfter}</p> : null}
            <span className="text-muted-foreground font-mono text-xs">{formatDateTime(candidate.createdAt)}</span>
        </li>
    );
}

/**
 * Gate-edit corpus candidates (GAP-A1) — the clinician approve-vs-edit
 * learning-loop export, with a "promote to golden case" affordance per row.
 * Rows are PHI-REDACTED AT WRITE (see the `GateEditExemplar` model), so
 * unlike `GoldenSetsPanel`'s cases this has nothing raw clinical to hide;
 * every row still carries `reviewStatus: PENDING_SME_REVIEW` — these are
 * proposals, never auto-admitted to a golden set.
 */
export function GateEditExemplarsPanel() {
    const candidatesQuery = useGateEditExemplars({ limit: PAGE_LIMIT });
    const [promoting, setPromoting] = useState<GateEditCorpusCandidate | null>(null);
    const candidates = candidatesQuery.data?.candidates ?? [];

    return (
        <Card className="gap-3 py-4">
            <CardHeader className="gap-1 px-4">
                <h2 className="text-sm font-medium">Gate-edit exemplars</h2>
                <span className="text-muted-foreground text-sm">
                    {candidatesQuery.data ? `${candidatesQuery.data.count} candidates` : ' '}
                    <span aria-hidden className="font-mono text-xs">
                        {' '}
                        {'·'} GET gate-edit-exemplars {'·'} unreviewed proposals
                    </span>
                </span>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-4">
                {candidatesQuery.isLoading ? (
                    <div className="flex flex-col gap-2">
                        {Array.from({ length: 3 }, (_, index) => (
                            <div key={index} className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
                                <Skeleton className="h-4 w-2/3" />
                                <Skeleton className="h-3 w-1/2" />
                            </div>
                        ))}
                    </div>
                ) : candidatesQuery.error ? (
                    <ErrorState error={candidatesQuery.error} onRetry={() => void candidatesQuery.refetch()} />
                ) : candidates.length === 0 ? (
                    <EmptyState
                        icon={IconClipboardList}
                        title="No gate-edit exemplars yet"
                        description="Clinician approve/edit signals accumulate here as candidates for the eval regression corpus."
                    />
                ) : (
                    <ul className="flex flex-col gap-2" aria-label="Gate-edit exemplars">
                        {candidates.map((candidate) => (
                            <CandidateRow key={candidate.id} candidate={candidate} onPromote={() => setPromoting(candidate)} />
                        ))}
                    </ul>
                )}
                <PromoteToGoldenCaseDialog
                    key={promoting?.id ?? 'none'}
                    candidate={promoting}
                    onOpenChange={(open) => !open && setPromoting(null)}
                />
            </CardContent>
        </Card>
    );
}
