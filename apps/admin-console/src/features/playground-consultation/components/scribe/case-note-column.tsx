'use client';

/**
 * Column 3 of the Consultation Scribe workspace (TASK-543): the case
 * note. Shows the LIVE running SOAP (SSE snapshot) while recording, then the
 * PERSISTED personalized draft (`SummaryResult` — same artifact on both the
 * plain and harness paths) once one exists. The harness assurance envelope is
 * folded in as a compact status strip (stage progress → gate/safety outcome,
 * expandable to per-claim verdicts) so the Documentation-review tab's
 * safety-relevant signals survive the single-view redesign. Sign & save runs
 * the existing approve mutation; the server-enforced safety gate surfaces here
 * as the pre-emptive override affordance rather than a surprising 409.
 */

import { useMemo, useState } from 'react';
import { IconCheck, IconChevronDown, IconClipboardCheck, IconCopy, IconFileText, IconShieldCheck, IconShieldExclamation } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Collapsible, CollapsibleTrigger } from '@arcaai/ui/components/shadcn/collapsible';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { cn } from '@arcaai/ui';
import { EmptyState } from '@/shared/state/empty-state';
import {
    claimVerdictBucket,
    type HarnessAssuranceSnapshot,
    type HarnessProgressSnapshot,
    type LiveSummaryEntity,
    type LiveSummarySnapshot,
    type SummaryResult,
} from '../../api';

/** SOAP-ish accent for a live section, keyed by title (design frame styling). */
function sectionAccent(title: string): string {
    switch (title.trim().toUpperCase().charAt(0)) {
        case 'S':
            return 'bg-primary text-primary-foreground';
        case 'O':
            return 'bg-ai text-ai-foreground';
        case 'A':
            return 'bg-warning text-warning-foreground';
        case 'P':
            return 'bg-success text-success-foreground';
        default:
            return 'bg-secondary text-secondary-foreground';
    }
}

// ─── assurance strip ───

export interface AssuranceStripProps {
    progress: HarnessProgressSnapshot | null;
    assurance: HarnessAssuranceSnapshot | null;
}

/**
 * Harness status fold: drafting stages while in flight; gate/safety outcome
 * once assurance lands. Renders nothing when the harness never ran (plain
 * path) — absence of the envelope is itself truthful.
 */
export function AssuranceStrip({ progress, assurance }: AssuranceStripProps) {
    const [open, setOpen] = useState(false);

    const stages = progress?.stages ?? [];
    const done = stages.filter((stage) => stage.status === 'completed').length;
    const activeStage = stages.find((stage) => stage.status === 'active');
    const failedStage = stages.find((stage) => stage.status === 'failed');
    const drafting = stages.length > 0 && !progress?.closed && !failedStage;

    const claims = assurance?.claims ?? [];
    const reviewCount = claims.filter((claim) => claimVerdictBucket(claim.verdict) === 'review').length;
    const hasAssurance = !!assurance && (claims.length > 0 || assurance.gateDecision !== undefined || assurance.safetyFlag !== undefined);

    if (stages.length === 0 && !hasAssurance) return null;

    return (
        <div className="bg-muted/40 shrink-0 rounded-lg border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {drafting ? (
                    <span className="flex items-center gap-2">
                        <Spinner aria-hidden className="size-3.5" />
                        <span className="font-medium">{activeStage?.label ?? 'Drafting note'}…</span>
                        <span className="text-muted-foreground text-xs">
                            {done}/{stages.length} stages
                        </span>
                    </span>
                ) : failedStage ? (
                    <span className="text-destructive flex items-center gap-1.5 font-medium">
                        <IconShieldExclamation aria-hidden className="size-4" />
                        {failedStage.label} failed
                    </span>
                ) : null}
                {hasAssurance ? (
                    <>
                        {assurance?.safetyFlag ? (
                            <Badge variant="destructive" className="gap-1">
                                <IconShieldExclamation aria-hidden className="size-3" />
                                Safety flag
                            </Badge>
                        ) : assurance?.gateDecision ? (
                            <Badge variant={assurance.gateDecision.toLowerCase() === 'pass' ? 'default' : 'secondary'} className="gap-1">
                                <IconShieldCheck aria-hidden className="size-3" />
                                Gate: {assurance.gateDecision}
                            </Badge>
                        ) : null}
                        {assurance?.reducedAssurance ? <Badge variant="outline">Reduced assurance</Badge> : null}
                        {claims.length > 0 ? (
                            <span className="text-muted-foreground text-xs">
                                {claims.length - reviewCount}/{claims.length} claims pass
                            </span>
                        ) : null}
                    </>
                ) : null}
                {drafting && stages.length > 0 ? <Progress value={(done / stages.length) * 100} className="h-1.5 w-24" aria-label="Drafting progress" /> : null}
                {claims.length > 0 ? (
                    <Collapsible open={open} onOpenChange={setOpen} className="ms-auto">
                        <CollapsibleTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                                Claims
                                <IconChevronDown aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
                            </Button>
                        </CollapsibleTrigger>
                    </Collapsible>
                ) : null}
            </div>
            {open && claims.length > 0 ? (
                <ul className="mt-2 flex list-none flex-col gap-1 border-t pt-2">
                    {claims.map((claim) => {
                        const bucket = claimVerdictBucket(claim.verdict);
                        return (
                            <li key={`${claim.claimId}-${claim.sensor}`} className="flex items-center gap-2 text-xs">
                                <Badge variant={bucket === 'pass' ? 'outline' : 'secondary'} className="w-16 justify-center">
                                    {bucket === 'pass' ? 'PASS' : 'REVIEW'}
                                </Badge>
                                <span className="text-muted-foreground font-mono">{claim.sensor}</span>
                                <span className="truncate">{claim.label ?? claim.claimId}</span>
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </div>
    );
}

// ─── the column ───

export interface CaseNoteColumnProps {
    hasConsultation: boolean;
    isRecording: boolean;
    live: LiveSummarySnapshot | null;
    liveStatus: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
    draft: SummaryResult | null;
    draftLoading: boolean;
    progress: HarnessProgressSnapshot | null;
    assurance: HarnessAssuranceSnapshot | null;
    /** Manual generate — hidden entirely when the harness owns drafting. */
    onGenerate: (() => void) | null;
    generatePending: boolean;
    onApprove: (options: { overrideSafetyFlag: boolean }) => void;
    approvePending: boolean;
    approved: boolean;
}

export function CaseNoteColumn(props: CaseNoteColumnProps) {
    const { hasConsultation, isRecording, live, draft, draftLoading, progress, assurance, onGenerate, generatePending, onApprove, approvePending, approved } = props;
    const [overrideSafety, setOverrideSafety] = useState(false);

    // The live snapshot is the mid-recording scratch preview; the persisted
    // draft takes over as soon as it exists (it is the reviewable artifact).
    const showLive = !draft && (isRecording || !!live);
    const liveSections = live?.sections ?? [];
    const liveEntities: LiveSummaryEntity[] = live?.entities ?? [];

    const provenance = useMemo(() => {
        const meta = draft?.structuredData;
        if (!meta) return null;
        const bits = [meta.llmProvider, meta.modelName, typeof meta.processingTimeMs === 'number' ? `${meta.processingTimeMs} ms` : null].filter(Boolean);
        return bits.length > 0 ? bits.join(' · ') : null;
    }, [draft]);

    async function handleCopy() {
        const text = draft?.content ?? live?.runningSummary ?? '';
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            toast.success('Note copied to clipboard');
        } catch {
            toast.error('Could not copy the note');
        }
    }

    return (
        <section aria-label="Case note" className="bg-card flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2.5 border-b p-3">
                <div className="min-w-0">
                    <h2 className="text-sm font-bold">Case note</h2>
                    <p className="text-muted-foreground truncate text-xs">
                        {draft ? (provenance ? `Personalized draft · ${provenance}` : 'Personalized draft') : showLive ? 'Running SOAP · auto-drafted live' : 'Drafts appear here after a session'}
                    </p>
                </div>
                {showLive && isRecording ? (
                    <span className="border-ai/40 bg-ai/10 text-ai flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
                        <Spinner aria-hidden className="size-3.5" />
                        Note assistant drafting
                    </span>
                ) : null}
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
                <AssuranceStrip progress={progress} assurance={assurance} />

                {!hasConsultation ? (
                    <EmptyState icon={IconFileText} title="No case note" description="Select a consultation to see its note." />
                ) : draftLoading ? (
                    <div className="flex flex-col gap-3" aria-hidden>
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-24 w-full" />
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-32 w-full" />
                    </div>
                ) : draft ? (
                    <article aria-label="Personalized draft note" className="text-sm leading-relaxed whitespace-pre-wrap">
                        {draft.content}
                    </article>
                ) : showLive && liveSections.length > 0 ? (
                    <div className="flex flex-col gap-4" aria-label="Live running summary">
                        {liveSections.map((section) => (
                            <div key={section.title} className="flex gap-2.5">
                                <span aria-hidden className={cn('flex size-5.5 shrink-0 items-center justify-center rounded-md text-xs font-extrabold', sectionAccent(section.title))}>
                                    {section.title.trim().charAt(0).toUpperCase()}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <h3 className="mb-1 text-xs font-bold tracking-wide uppercase">{section.title}</h3>
                                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{section.content}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : showLive && live?.runningSummary ? (
                    <p className="text-sm leading-relaxed whitespace-pre-wrap" aria-label="Live running summary">
                        {live.runningSummary}
                    </p>
                ) : isRecording ? (
                    <div className="flex flex-col gap-3" aria-label="Waiting for the first live summary">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-2/3" />
                    </div>
                ) : (
                    <EmptyState
                        icon={IconFileText}
                        title="No draft yet"
                        description={onGenerate ? 'Record a session, or generate a note from the captured transcript.' : 'Record a session — the documentation harness drafts the note automatically.'}
                    />
                )}

                {showLive && liveEntities.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5 border-t pt-3" aria-label="Detected entities">
                        {liveEntities.map((entity, index) => (
                            <Badge key={`${entity.text}-${index}`} variant="secondary" className="gap-1">
                                {entity.text}
                                {entity.icd10 ? (
                                    <span className="bg-accent text-accent-foreground rounded px-1 font-mono text-[10px] font-bold">{entity.icd10}</span>
                                ) : (
                                    <span className="text-muted-foreground font-mono text-[10px]">{entity.type}</span>
                                )}
                            </Badge>
                        ))}
                    </div>
                ) : null}
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2 border-t p-3">
                <Button variant="outline" size="sm" onClick={handleCopy} disabled={!draft && !live?.runningSummary}>
                    <IconCopy aria-hidden />
                    Copy
                </Button>
                {onGenerate ? (
                    <Button variant="outline" size="sm" onClick={onGenerate} disabled={generatePending || isRecording}>
                        {generatePending ? <Spinner aria-hidden /> : <IconClipboardCheck aria-hidden />}
                        Generate note
                    </Button>
                ) : null}
                <div className="ms-auto flex items-center gap-3">
                    {assurance?.safetyFlag && draft && !approved ? (
                        <label className="text-destructive flex items-center gap-1.5 text-xs font-medium">
                            <Checkbox checked={overrideSafety} onCheckedChange={(checked) => setOverrideSafety(checked === true)} aria-label="Override safety flag" />
                            Override safety flag
                        </label>
                    ) : null}
                    <Button size="sm" onClick={() => onApprove({ overrideSafetyFlag: overrideSafety })} disabled={!draft || approvePending || approved || (assurance?.safetyFlag === true && !overrideSafety)}>
                        {approvePending ? <Spinner aria-hidden /> : <IconCheck aria-hidden />}
                        {approved ? 'Signed' : 'Sign & save'}
                    </Button>
                </div>
            </div>
        </section>
    );
}
