/**
 * Clinical Workflow Demonstration Playground (TASK-330 P3).
 *
 * End-to-end ambient-scribe walkthrough: impersonate a doctor → open a
 * harness-enabled consultation → record with live captions + live summary →
 * add mid-visit context → dual-capture audio → stop → review the auto-drafted
 * SOAP note with click-to-inspect provenance → edit → sign. Artifacts lists
 * everything captured.
 */
import { ImpersonationGuard } from '@/components/impersonation-guard';
import { Main } from '@/components/layout/main';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Loader2, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { clinicalWorkspaceKeys, useDraftReadiness } from './api/queries';
import { ArtifactsPanel } from './components/artifacts-panel';
import { Cockpit } from './components/cockpit';
import { LaunchPanel } from './components/launch-panel';
import { ReviewPanel } from './components/review-panel';
import { useLiveSummaryStream } from './hooks/use-live-summary-stream';
import { selectTranscriptSources } from './lib/artifacts';
import { canReview, clinicalFlowReducer, initialFlowState } from './lib/flow';
import type { RecordingStateResponse } from './types';

type WorkspaceTab = 'cockpit' | 'review' | 'artifacts';

function ClinicalWorkspaceInner() {
  const [flow, dispatch] = useReducer(clinicalFlowReducer, initialFlowState);
  const [tab, setTab] = useState<WorkspaceTab>('cockpit');
  const [resetOpen, setResetOpen] = useState(false);
  const queryClient = useQueryClient();

  // Poll for the harness draft once recording has stopped (TASK-339 FU2). The
  // hook stops polling as soon as the draft appears (or after a timeout).
  const draft = useDraftReadiness({ consultationId: flow.consultationId, waiting: flow.stage === 'stopped' });
  const items = draft.items;
  const latestNote = draft.note;
  const transcripts = useMemo(() => selectTranscriptSources(items), [items]);
  const noteId = draft.noteId;

  // Surface the drafted note into the flow so the Review tab unlocks.
  useEffect(() => {
    if (noteId) dispatch({ type: 'NOTE_READY', noteContextItemId: noteId });
  }, [noteId]);

  const handleOpened = (consultationId: string) => {
    dispatch({ type: 'CONSULTATION_OPENED', consultationId });
    setTab('cockpit');
  };

  const handleRecordingStarted = (state: RecordingStateResponse) => {
    dispatch({ type: 'RECORDING_STARTED', state });
  };

  const handleRecordingStopped = (state: RecordingStateResponse) => {
    dispatch({ type: 'RECORDING_STOPPED', state });
    if (flow.consultationId) {
      void queryClient.invalidateQueries({ queryKey: clinicalWorkspaceKeys.context(flow.consultationId) });
    }
    setTab('review');
  };

  const handleReset = () => {
    dispatch({ type: 'RESET' });
    setTab('cockpit');
    setResetOpen(false);
  };

  // Live summary subscription is owned here and shared with the cockpit.
  const liveSummary = useLiveSummaryStream({ consultationId: flow.consultationId, enabled: flow.recording });

  if (flow.stage === 'launch' || !flow.consultationId) {
    return (
      <div className="space-y-6">
        <WorkspaceHeader />
        <LaunchPanel onOpened={handleOpened} />
      </div>
    );
  }

  const reviewEnabled = canReview(flow);

  return (
    <div className="space-y-4">
      <WorkspaceHeader
        consultationId={flow.consultationId}
        recording={flow.recording}
        onReset={() => setResetOpen(true)}
      />

      <Tabs value={tab} onValueChange={(value) => setTab(value as WorkspaceTab)}>
        <TabsList>
          <TabsTrigger value="cockpit">Cockpit</TabsTrigger>
          <TabsTrigger value="review" disabled={!reviewEnabled} data-testid="tab-review">
            Review &amp; sign
            {draft.status === 'generating' && <Loader2 className="ml-1.5 size-3 animate-spin" data-testid="tab-review-generating" />}
          </TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
        </TabsList>

        <TabsContent value="cockpit" className="mt-4">
          <Cockpit
            consultationId={flow.consultationId}
            recording={flow.recording}
            liveSummary={liveSummary}
            onRecordingStarted={handleRecordingStarted}
            onRecordingStopped={handleRecordingStopped}
          />
        </TabsContent>

        <TabsContent value="review" className="mt-4">
          <ReviewPanel
            consultationId={flow.consultationId}
            noteContextItemId={noteId}
            noteContent={latestNote?.content}
            transcripts={transcripts}
            draftStatus={draft.status}
            onRefreshDraft={draft.refetch}
          />
        </TabsContent>

        <TabsContent value="artifacts" className="mt-4">
          <ArtifactsPanel consultationId={flow.consultationId} />
        </TabsContent>
      </Tabs>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Start over?</DialogTitle>
            <DialogDescription>
              This clears the playground walkthrough and returns to the launch screen. The consultation and everything captured remain saved on the
              server.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReset} data-testid="reset-confirm">
              Start over
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WorkspaceHeader({ consultationId, recording, onReset }: { consultationId?: string; recording?: boolean; onReset?: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Clinical Workflow Playground</h1>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
          A best-practice ambient-scribe cockpit: record a visit with live captions and a running AI summary, add mid-visit context, then review the
          auto-drafted SOAP note with click-to-inspect provenance before signing.
        </p>
      </div>
      {consultationId && (
        <div className="flex items-center gap-2">
          {recording ? (
            <Badge variant="default" className="gap-1.5">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-300 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-red-100" />
              </span>
              Recording
            </Badge>
          ) : (
            <Badge variant="secondary">Consultation open</Badge>
          )}
          <Badge variant="outline" className="font-mono text-[10px]">
            {consultationId.slice(0, 8)}…
          </Badge>
          {onReset && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onReset} data-testid="workspace-reset">
              <RotateCcw className="size-3.5" />
              Start over
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default function ClinicalWorkspacePage() {
  return (
    <Main>
      <ImpersonationGuard
        featureName="the Clinical Workflow Playground"
        featureDescription="The clinical workflow playground runs as a doctor. As an admin, impersonate a doctor to open a consultation, record a visit, and review the AI-drafted note."
      >
        <ClinicalWorkspaceInner />
      </ImpersonationGuard>
    </Main>
  );
}
