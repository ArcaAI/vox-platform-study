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
import { DEFAULT_TRANSCRIPTION_PIPELINE_ID } from '@/features/audio/constants';
import { useRealtimeTranscription } from '@/hooks/use-realtime-transcription';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent } from '@arcaai/ui/card';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { useArcaConfig, useArcaStore, type AgenticClient } from '@arcaai/vox';
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
  const dual = useDualCapture(consultationId);
  const { resolvedConfig } = useArcaConfig();

  const [consentAck, setConsentAck] = useState(false);
  const [intent, setIntent] = useState<'idle' | 'starting' | 'recording' | 'stopping'>('idle');
  const recordingStartedRef = useRef(false);

  // Resolve the remote transcription pipeline: explicit prop > the user/tenant
  // cascade-resolved config (AgenticProvider injects the per-user remote pipeline
  // into stt.transcriptionPipelineId) > system default. The hardcoded default is
  // SYSTEM-tenant-owned and is NOT shared-read into customer tenants, so using it
  // for a customer-tenant doctor yields a "Pipeline … not found" on session start.
  const resolvedPipelineId = pipelineId ?? resolvedConfig?.stt?.transcriptionPipelineId ?? DEFAULT_TRANSCRIPTION_PIPELINE_ID;

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
    setIntent('starting');
    try {
      await realtime.start({ pipelineId: resolvedPipelineId, consultationId });
    } catch (err) {
      setIntent('idle');
      toast.error(err instanceof Error ? err.message : 'Failed to start recording');
    }
  }, [consentAck, realtime, resolvedPipelineId, consultationId]);

  const handleStop = useCallback(async () => {
    if (!apiClient) return;
    setIntent('stopping');
    // Flush dual-capture blobs while the mic tracks are still live.
    await dual.stopAndPersist();
    await realtime.stop();
    try {
      const state = await stopRecording(apiClient, consultationId, true);
      onRecordingStopped(state);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to stop recording');
    } finally {
      recordingStartedRef.current = false;
      setIntent('idle');
    }
  }, [apiClient, dual, realtime, consultationId, onRecordingStopped]);

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

          {realtime.isStreaming && (
            <span className="text-muted-foreground text-xs tabular-nums">{(realtime.bytesSent / 1024).toFixed(0)} KB sent</span>
          )}

          {realtime.error && (
            <span className="text-destructive flex items-center gap-1 text-xs">
              <AlertCircle className="size-3.5" />
              {realtime.error}
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
              {realtime.transcripts.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {realtime.isStreaming ? 'Listening… speak to see the live transcript.' : 'Start recording to capture the live transcript.'}
                </p>
              ) : (
                realtime.transcripts.map((entry) => (
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
