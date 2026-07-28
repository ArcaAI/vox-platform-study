'use client';

/**
 * Frame 50.1 — Documentation Review phase. Streams the harness
 * stage checklist (`consultation_harness_progress:<id>`) and the per-claim
 * assurance verdicts (`consultation_harness_assurance:<id>`, terminal named
 * event `assurance_complete`), shows the persisted draft note with
 * provenance, and wires "Approve & sign-off" to
 * `POST :id/summary/:contextItemId/approve`.
 */

import { useState } from 'react';
import { IconAlertTriangle, IconArrowLeft, IconCircle, IconCircleCheck, IconFileOff, IconSignature } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import type { StreamStatus } from '@/shared/streams';
import {
  claimVerdictBucket,
  useApproveSummary,
  useHarnessAssuranceStream,
  useHarnessProgressStream,
  useLatestSummary,
  useNamedEntities,
  type HarnessStage,
} from '../api';

const STREAM_META: Record<StreamStatus, { label: string; role: StatusColorRole }> = {
  idle: { label: 'Idle', role: 'neutral' },
  connecting: { label: 'Connecting', role: 'info' },
  open: { label: 'Live', role: 'success' },
  error: { label: 'Offline', role: 'destructive' },
  closed: { label: 'Done', role: 'neutral' },
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function StageIcon({ status }: { status: HarnessStage['status'] }) {
  switch (status) {
    case 'completed':
      return <IconCircleCheck aria-hidden className="text-success size-4 shrink-0" />;
    case 'active':
      return <Spinner className="text-primary size-4 shrink-0" />;
    case 'failed':
      return <IconAlertTriangle aria-hidden className="text-destructive size-4 shrink-0" />;
    default:
      return <IconCircle aria-hidden className="text-muted-foreground/60 size-4 shrink-0" />;
  }
}

export function DocumentationReviewPanel({ consultationId, onBackToDemo }: { consultationId: string; onBackToDemo?: () => void }) {
  const progress = useHarnessProgressStream(consultationId);
  const assurance = useHarnessAssuranceStream(consultationId);
  const draft = useLatestSummary(consultationId);
  const entities = useNamedEntities(consultationId, 'single', !!draft.data);
  const approve = useApproveSummary();

  const [overrideSafetyFlag, setOverrideSafetyFlag] = useState(false);
  const [signedOff, setSignedOff] = useState(false);

  const stages = progress.snapshot?.stages ?? [];
  const activeStage = stages.find((stage) => stage.status === 'active');
  const completedCount = stages.filter((stage) => stage.status === 'completed').length;
  const currentOrdinal = activeStage?.ordinal ?? completedCount;

  const claims = assurance.snapshot?.claims ?? [];
  const claimTotal = assurance.snapshot?.total;
  const assuranceRunning = !assurance.snapshot?.closed && typeof claimTotal === 'number' && claims.length < claimTotal;
  const safetyFlagged = assurance.snapshot?.safetyFlag === true;

  function handleApprove() {
    const noteId = draft.data?.id;
    if (!noteId) return;
    approve.mutate(
      { consultationId, contextItemId: noteId, body: overrideSafetyFlag ? { overrideSafetyFlag: true } : {} },
      {
        onSuccess: () => {
          setSignedOff(true);
          toast.success('Note approved and signed off');
        },
        onError: (error) => toast.error(errorMessage(error, 'Approval failed')),
      },
    );
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div className="flex flex-col gap-1.5">
              <CardTitle>Harness progress</CardTitle>
              <CardDescription>Clinical Documentation Harness stages for the draft run.</CardDescription>
            </div>
            <StatusBadge label={STREAM_META[progress.status].label} colorRole={STREAM_META[progress.status].role} />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {stages.length === 0 ? (
              <p className="text-muted-foreground text-sm">Waiting for harness progress&hellip; stages stream in while an async draft generates.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">
                    Stage {currentOrdinal}/{stages.length}
                  </span>
                  <Badge variant="outline">{progress.snapshot?.closed ? 'Review gate: ready' : 'Review gate: pending'}</Badge>
                </div>
                <ol aria-label="Harness stages" className="flex flex-col gap-2">
                  {stages.map((stage) => (
                    <li key={stage.stage} className="flex items-center gap-2 text-sm">
                      <StageIcon status={stage.status} />
                      <span className={stage.status === 'pending' ? 'text-muted-foreground' : undefined}>{stage.label}</span>
                      {stage.attempt > 1 ? <span className="text-muted-foreground text-xs">attempt {stage.attempt}</span> : null}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div className="flex flex-col gap-1.5">
              <CardTitle>Claim assurance</CardTitle>
              <CardDescription>Per-claim sensor verdicts (groundedness, citation verify, safety).</CardDescription>
            </div>
            <StatusBadge label={STREAM_META[assurance.status].label} colorRole={STREAM_META[assurance.status].role} />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {assurance.snapshot?.gateDecision || safetyFlagged ? (
              <div className="flex flex-wrap items-center gap-2">
                {assurance.snapshot?.gateDecision ? (
                  <StatusBadge label={`Gate: ${assurance.snapshot.gateDecision}`} colorRole={safetyFlagged ? 'warning' : 'success'} />
                ) : null}
                {safetyFlagged ? (
                  <Badge variant="outline" className="border-warning/40 text-warning-strong gap-1">
                    <IconAlertTriangle aria-hidden className="size-3" />
                    Claim flagged for review
                  </Badge>
                ) : null}
                {assurance.snapshot?.reducedAssurance ? <Badge variant="outline">Reduced assurance</Badge> : null}
              </div>
            ) : null}
            {claims.length === 0 && !assuranceRunning ? (
              <p className="text-muted-foreground text-sm">No claim verdicts yet — they stream in while safety sensors run.</p>
            ) : (
              <ul aria-label="Claim verdicts" className="flex flex-col gap-2">
                {claims.map((claim) => {
                  const bucket = claimVerdictBucket(claim.verdict);
                  return (
                    <li key={claim.claimId} className="flex items-center gap-2 text-sm">
                      <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{claim.claimId}</code>
                      <span className="min-w-0 flex-1 truncate">{claim.label ?? claim.claimId}</span>
                      <span className="text-muted-foreground text-xs">{claim.sensor}</span>
                      <StatusBadge label={bucket === 'pass' ? 'PASS' : 'REVIEW'} colorRole={bucket === 'pass' ? 'success' : 'warning'} />
                    </li>
                  );
                })}
                {assuranceRunning ? (
                  <li className="flex items-center gap-2 text-sm">
                    <Spinner className="size-4 shrink-0" />
                    <span className="text-muted-foreground">
                      Sensor running ({claims.length}/{claimTotal})
                    </span>
                  </li>
                ) : null}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Draft note</CardTitle>
          <CardDescription>The persisted summary draft, with generation provenance.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {draft.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-9 w-40" />
            </div>
          ) : draft.isError ? (
            <ErrorState title="Couldn't load the draft" error={draft.error} onRetry={() => void draft.refetch()} />
          ) : !draft.data ? (
            <EmptyState
              icon={IconFileOff}
              title="No draft awaiting review"
              description="Generate a summary on the demo tab first — the draft lands here for review and sign-off."
              action={
                onBackToDemo ? (
                  <Button variant="outline" onClick={onBackToDemo}>
                    <IconArrowLeft aria-hidden />
                    Back to consultation demo
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                {draft.data.structuredData?.llmProvider ? <Badge variant="outline">{draft.data.structuredData.llmProvider}</Badge> : null}
                {draft.data.structuredData?.modelName ? <Badge variant="outline">{draft.data.structuredData.modelName}</Badge> : null}
                {typeof draft.data.structuredData?.processingTimeMs === 'number' ? (
                  <span>{draft.data.structuredData.processingTimeMs} ms</span>
                ) : null}
                {entities.data ? <span>{entities.data.totalCount} entities detected</span> : null}
              </div>
              <pre className="bg-muted/50 max-h-96 overflow-y-auto rounded-md border p-3 font-sans text-sm whitespace-pre-wrap">
                {draft.data.content}
              </pre>
              {safetyFlagged ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="pc-override-safety"
                    checked={overrideSafetyFlag}
                    onCheckedChange={(checked) => setOverrideSafetyFlag(checked === true)}
                  />
                  <Label htmlFor="pc-override-safety" className="text-sm font-normal">
                    Override safety flag
                  </Label>
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <Button onClick={handleApprove} disabled={approve.isPending || signedOff}>
                  {approve.isPending ? <Spinner /> : <IconSignature aria-hidden />}
                  Approve &amp; sign-off
                </Button>
                {signedOff ? <StatusBadge label="Signed off" colorRole="success" /> : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
