/**
 * CapturePanel (TASK-330 P3, WS3 + WS4 capture lane).
 *
 * Owns the live-capture lifecycle for the cockpit:
 *   - consent gate → Start
 *   - `useRealtimeTranscription` for live captions over the existing STT WS
 *   - `POST /recording/start { sessionId }` once the STT session exists, so the
 *     backend correlates the live summary + transcript with the recording
 *   - dual audio capture (raw + processed) via `useDualCapture`, flushed on Stop
 *     BEFORE the mic tracks are torn down, then `POST /recording/stop`
 *
 * Recording state changes are reported up so the flow machine + live-summary SSE
 * subscription stay in lockstep.
 */
import { LiveByteCount } from '@/components/live-byte-count';
import { useRealtimeTranscription } from '@/hooks/use-realtime-transcription';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent } from '@arcaai/ui/card';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { useArcaAudio, useArcaConfig, useArcaStore, type AgenticClient } from '@arcaai/vox';
import { AlertCircle, Layers, Loader2, Mic, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { startRecording, stopRecording } from '../api/clinical-workspace.api';
import { useDualCapture } from '../hooks/use-dual-capture';
import type { RecordingStateResponse } from '../types';
import { ConsentBanner } from './consent-banner';

interface CapturePanelProps {
  consultationId: string;
  recording: boolean;
  onRecordingStarted: (state: RecordingStateResponse) => void;
  onRecordingStopped: (state: RecordingStateResponse) => void;
  pipelineId?: string;
}

const formatKbSent = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB sent`;

const DUAL_CAPTURE_LABEL: Record<string, string> = {
  idle: '',
  capturing: 'Dual capture active (raw + processed)',
  uploading: 'Uploading raw + processed audio…',
  saved: 'Raw + processed audio saved',
  error: 'Dual capture failed',
};

export function CapturePanel({ consultationId, recording, onRecordingStarted, onRecordingStopped, pipelineId }: CapturePanelProps) {
  const apiClient = useArcaStore((s: { apiClient: AgenticClient | null }) => s.apiClient);
  const realtime = useRealtimeTranscription();
  const localAudio = useArcaAudio();
  const dual = useDualCapture(consultationId);
  const { resolvedConfig } = useArcaConfig();

  const [consentAck, setConsentAck] = useState(false);
  const [intent, setIntent] = useState<'idle' | 'starting' | 'recording' | 'stopping'>('idle');
  const recordingStartedRef = useRef(false);

  // TASK-356 Phase 4 — the EFFECTIVE transcription mode resolved server-side
  // (UserPreferences cascade: tenant lock ⇒ tenant default; else the doctor's
  // workflowMode) and injected by AgenticProvider into resolvedConfig.stt. LOCAL
  // runs the browser pipeline (no STT-WS session, no pipelineId); BACKEND keeps
  // the existing WS path. Undefined ⇒ BACKEND (back-compat default).
  const isLocalTranscription = resolvedConfig?.stt?.transcriptionMode === 'LOCAL';

  // Resolve the remote transcription pipeline: explicit prop > the user/tenant
  // cascade-resolved config (AgenticProvider injects the per-user remote pipeline
  // into stt.transcriptionPipelineId). TASK-342 R2 — there is intentionally NO
  // hardcoded fallback: the old DEFAULT_TRANSCRIPTION_PIPELINE_ID is SYSTEM-tenant-
  // owned and is NOT shared-read into customer tenants, so silently using it for a
  // customer-tenant doctor produced a cross-tenant "Pipeline … not found" 404 on
  // session start. When nothing resolves, handleStart blocks with an actionable error.
  const resolvedPipelineId = pipelineId ?? resolvedConfig?.stt?.transcriptionPipelineId;

  // Unified live-capture view: the LOCAL browser pipeline and the BACKEND STT-WS
  // path expose streaming state + transcript chunks through different hooks.
  const isStreaming = isLocalTranscription ? localAudio.isCapturing : realtime.isStreaming;
  const captureError = isLocalTranscription
    ? localAudio.error instanceof Error
      ? localAudio.error.message
      : null
    : realtime.error;
  const transcriptEntries = isLocalTranscription
    ? localAudio.transcriptSegments.map((seg, i) => ({
        id: `local-${i}`,
        isFinal: seg.isFinal,
        speakerLabel: seg.speakerLabel,
        text: seg.text,
      }))
    : realtime.transcripts;

  // Once the STT session is live, bind the recording to it and notify the flow.
  useEffect(() => {
    if (intent !== 'starting' || !realtime.isStreaming || !realtime.sessionId || recordingStartedRef.current || !apiClient) return;
    recordingStartedRef.current = true;
    void startRecording(apiClient, consultationId, realtime.sessionId)
      .then((state) => {
        setIntent('recording');
        onRecordingStarted(state);
      })
      .catch((err) => {
        recordingStartedRef.current = false;
        setIntent('idle');
        toast.error(err instanceof Error ? err.message : 'Failed to start recording');
      });
  }, [intent, realtime.isStreaming, realtime.sessionId, apiClient, consultationId, onRecordingStarted]);

  // Tap the raw mic stream for dual capture as soon as it is available.
  useEffect(() => {
    if (!realtime.isStreaming || !realtime.inputStream || dual.isCapturing || dual.status !== 'idle') return;
    dual.start(realtime.inputStream);
  }, [realtime.isStreaming, realtime.inputStream, dual]);

  const handleStart = useCallback(async () => {
    if (!consentAck) {
      toast.error('Please confirm patient consent before recording');
      return;
    }

    // TASK-356 Phase 4 — LOCAL mode: drive the SDK browser pipeline. It needs no
    // STT-WS session and no `pipelineId`, so the remote-pipeline guard below is
    // skipped. The recording is correlated WITHOUT a sessionId.
    if (isLocalTranscription) {
      setIntent('starting');
      try {
        await localAudio.start({ consultationId });
        if (apiClient && !recordingStartedRef.current) {
          recordingStartedRef.current = true;
          const state = await startRecording(apiClient, consultationId);
          setIntent('recording');
          onRecordingStarted(state);
        } else {
          setIntent('recording');
        }
      } catch (err) {
        recordingStartedRef.current = false;
        setIntent('idle');
        toast.error(err instanceof Error ? err.message : 'Failed to start recording');
      }
      return;
    }

    // TASK-342 R2 — block Start (rather than silently 404 mid-session) when no
    // tenant-scoped transcription pipeline is configured for this doctor.
    if (!resolvedPipelineId) {
      toast.error('No transcription pipeline is configured for your account. Ask an administrator to assign one before recording.');
      return;
    }
    setIntent('starting');
    try {
      await realtime.start({ pipelineId: resolvedPipelineId, consultationId });
    } catch (err) {
      setIntent('idle');
      toast.error(err instanceof Error ? err.message : 'Failed to start recording');
    }
  }, [consentAck, isLocalTranscription, localAudio, apiClient, realtime, resolvedPipelineId, consultationId, onRecordingStarted]);

  const handleStop = useCallback(async () => {
    if (!apiClient) return;
    setIntent('stopping');
    // Flush dual-capture blobs while the mic tracks are still live.
    await dual.stopAndPersist();
    // Stop the active capture path (LOCAL browser pipeline or BACKEND STT-WS).
    if (isLocalTranscription) {
      await localAudio.stop();
    } else {
      await realtime.stop();
    }
    try {
      const state = await stopRecording(apiClient, consultationId, true);
      onRecordingStopped(state);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to stop recording');
    } finally {
      recordingStartedRef.current = false;
      setIntent('idle');
    }
  }, [apiClient, dual, isLocalTranscription, localAudio, realtime, consultationId, onRecordingStopped]);

  const busy = intent === 'starting' || intent === 'stopping';
  const dualLabel = DUAL_CAPTURE_LABEL[dual.status];

  return (
    <div className="flex h-full flex-col gap-3">
      <ConsentBanner acknowledged={consentAck} onAcknowledgedChange={setConsentAck} recording={recording} />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          {recording ? (
            <Button variant="destructive" onClick={() => void handleStop()} disabled={intent === 'stopping'} data-testid="capture-stop">
              {intent === 'stopping' ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Square className="mr-1.5 size-4" />}
              Stop &amp; finalize
            </Button>
          ) : (
            <Button onClick={() => void handleStart()} disabled={!consentAck || busy} data-testid="capture-start">
              {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Mic className="mr-1.5 size-4" />}
              Start recording
            </Button>
          )}

          <Badge variant={recording ? 'default' : 'secondary'}>{recording ? 'Recording' : busy ? 'Preparing…' : 'Ready'}</Badge>

          {dualLabel && (
            <span className="text-muted-foreground flex items-center gap-1 text-xs" data-testid="dual-capture-status">
              <Layers className="size-3.5" />
              {dualLabel}
            </span>
          )}

          {!isLocalTranscription && realtime.isStreaming && (
            <span className="text-muted-foreground text-xs tabular-nums">
              <LiveByteCount handle={realtime.bytesSent} format={formatKbSent} />
            </span>
          )}

          {captureError && (
            <span className="text-destructive flex items-center gap-1 text-xs">
              <AlertCircle className="size-3.5" />
              {captureError}
            </span>
          )}
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="border-b px-4 py-2">
            <h3 className="text-sm font-medium">Live transcript</h3>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1.5 p-4" data-testid="capture-transcript">
              {transcriptEntries.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {isStreaming ? 'Listening… speak to see the live transcript.' : 'Start recording to capture the live transcript.'}
                </p>
              ) : (
                transcriptEntries.map((entry) => (
                  <p key={entry.id} data-final={entry.isFinal} className={entry.isFinal ? 'text-sm' : 'text-muted-foreground text-sm italic'}>
                    {entry.speakerLabel && <span className="text-muted-foreground mr-1 font-medium">{entry.speakerLabel}:</span>}
                    {entry.text}
                  </p>
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
