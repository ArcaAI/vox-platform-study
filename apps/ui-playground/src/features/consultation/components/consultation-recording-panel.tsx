import { DiarizationSeedingIndicator } from '@/features/audio/components/diarization-seeding-indicator';
import { DEFAULT_TRANSCRIPTION_PIPELINE_ID } from '@/features/audio/constants';
import { useRealtimeTranscription } from '@/hooks/use-realtime-transcription';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent } from '@arcaai/ui/card';
import { Skeleton } from '@arcaai/ui/skeleton';
import { DualStreamRecorder, useArcaConfig, useAudioRecordings, useStorage } from '@arcaai/vox';
import { formatDistanceToNow } from 'date-fns';
import { AlertCircle, Layers, Loader2, Mic, RefreshCw, Square, Waves } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

interface ConsultationRecordingPanelProps {
  consultationId: string;
  /** Override the transcription pipeline used for the live session. */
  pipelineId?: string;
}

const RECORDING_STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  creating_session: 'Creating session…',
  connecting: 'Connecting…',
  streaming: 'Recording',
  reconnecting: 'Reconnecting…',
  stopping: 'Stopping…',
  error: 'Error',
};

/**
 * Recording tab (TASK-329 P2) — in-flow consultation capture.
 *
 * Drives a live transcription session scoped to the consultation (server
 * persists the audio + transcript), and lists the consultation's audio
 * recordings. Recordings expose the dual-capture (X8) RAW/PROCESSED media ids
 * when present, via {@link useAudioRecordings}.
 */
export function ConsultationRecordingPanel({ consultationId, pipelineId }: ConsultationRecordingPanelProps) {
  const realtime = useRealtimeTranscription();
  const { recordings, isLoading: recordingsLoading, error: recordingsError, list, add } = useAudioRecordings();
  const storage = useStorage();
  const { resolvedConfig } = useArcaConfig();

  // TASK-331 doc-06 F2 — gate dual capture behind the resolved pipeline/tenant
  // config; default OFF when the flag is absent/unknown.
  const dualCaptureEnabled = (resolvedConfig?.audio as { dualCapture?: unknown } | undefined)?.dualCapture === true;

  // TASK-333 T5 — resolve the remote transcription pipeline: explicit prop >
  // the user/tenant cascade-resolved config (SDK config hook) > system default.
  const resolvedPipelineId =
    pipelineId ??
    (resolvedConfig?.stt as { transcriptionPipelineId?: string } | undefined)?.transcriptionPipelineId ??
    DEFAULT_TRANSCRIPTION_PIPELINE_ID;

  const dualRecorderRef = useRef<DualStreamRecorder | null>(null);

  const refreshRecordings = useCallback(() => {
    void list(consultationId).catch(() => {
      /* surfaced via recordingsError */
    });
  }, [consultationId, list]);

  useEffect(() => {
    refreshRecordings();
  }, [refreshRecordings]);

  // TASK-331 doc-06 F2 — capture the live audio with DualStreamRecorder once the
  // session exposes its input stream. Baseline `useRealtimeTranscription` only
  // surfaces the raw mic stream (no `TranscriptionPipeline` /
  // `getProcessedTrack()`), so both recorder inputs derive from that track; the
  // resolved-config flag governs whether the RAW stream is also persisted.
  useEffect(() => {
    if (!realtime.isStreaming || !realtime.inputStream || dualRecorderRef.current) return;
    const track = realtime.inputStream.getAudioTracks()[0];
    if (!track) return;
    const recorder = new DualStreamRecorder(track, track);
    recorder.start();
    dualRecorderRef.current = recorder;
  }, [realtime.isStreaming, realtime.inputStream]);

  useEffect(() => {
    return () => {
      void dualRecorderRef.current?.stop().catch(() => {});
      dualRecorderRef.current = null;
    };
  }, []);

  const handleStart = useCallback(async () => {
    try {
      await realtime.start({ pipelineId: resolvedPipelineId, consultationId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start recording');
    }
  }, [realtime, resolvedPipelineId, consultationId]);

  const handleStop = useCallback(async () => {
    await realtime.stop();

    // TASK-331 doc-06 F2 — persist the captured audio. The PROCESSED stream is
    // the canonical media; when dual capture is enabled we also upload the RAW
    // stream and attach both ids so the dual-capture badge reflects real data.
    const recorder = dualRecorderRef.current;
    dualRecorderRef.current = null;
    if (recorder) {
      try {
        const { raw, processed } = await recorder.stop();
        const processedKey = (
          await storage.uploadFile('attachments', new File([processed], 'processed.webm', { type: processed.type || 'audio/webm' }))
        ).key;
        if (dualCaptureEnabled) {
          const rawKey = (await storage.uploadFile('attachments', new File([raw], 'raw.webm', { type: raw.type || 'audio/webm' }))).key;
          await add(consultationId, { mediaId: processedKey, rawMediaId: rawKey, processedMediaId: processedKey });
        } else {
          await add(consultationId, { mediaId: processedKey });
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save recording');
      }
    }

    // Audio is persisted server-side during the session; refresh once it closes.
    refreshRecordings();
  }, [realtime, storage, add, consultationId, dualCaptureEnabled, refreshRecordings]);

  const busy = realtime.status !== 'idle' && realtime.status !== 'streaming' && realtime.status !== 'error';

  return (
    <div className="space-y-4" data-doc="consultation-recording">
      {/* Capture controls */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          {realtime.isStreaming ? (
            <Button variant="destructive" onClick={() => void handleStop()} data-doc="consultation-recording-stop">
              <Square className="mr-1.5 size-4" />
              Stop
            </Button>
          ) : (
            <Button onClick={() => void handleStart()} disabled={busy} data-doc="consultation-recording-start">
              {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Mic className="mr-1.5 size-4" />}
              Start recording
            </Button>
          )}

          <Badge variant={realtime.status === 'error' ? 'destructive' : realtime.isStreaming ? 'default' : 'secondary'}>
            {RECORDING_STATUS_LABEL[realtime.status] ?? realtime.status}
          </Badge>

          {/* TASK-331 doc-06 F8 — surface the diarization voice-profile seeding
              signal, matching the Audio playground's feedback. */}
          <DiarizationSeedingIndicator seeded={realtime.voiceProfileSeeded} />

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

      {/* Live transcript */}
      {(realtime.isStreaming || realtime.transcripts.length > 0) && (
        <Card>
          <CardContent className="max-h-64 space-y-1.5 overflow-y-auto p-4" data-doc="consultation-recording-transcript">
            {realtime.transcripts.length === 0 ? (
              <p className="text-muted-foreground text-sm">Listening… speak to see the live transcript.</p>
            ) : (
              realtime.transcripts.map((t) => (
                <p key={t.id} className={t.isFinal ? 'text-sm' : 'text-muted-foreground text-sm italic'}>
                  {t.speakerLabel && <span className="text-muted-foreground mr-1 font-medium">{t.speakerLabel}:</span>}
                  {t.text}
                </p>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* Recordings list */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Waves className="text-muted-foreground size-4" />
          <h3 className="text-sm font-medium">Recordings</h3>
          {recordings.length > 0 && (
            <Badge variant="outline" className="text-xs">
              {recordings.length}
            </Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={refreshRecordings} disabled={recordingsLoading}>
          <RefreshCw className="mr-1 size-3.5" />
          Refresh
        </Button>
      </div>

      {recordingsError && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-3 p-4">
            <AlertCircle className="text-destructive size-5 shrink-0" />
            <p className="text-destructive text-sm">{recordingsError.message}</p>
            <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={refreshRecordings}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {recordingsLoading && recordings.length === 0 ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : recordings.length === 0 && !recordingsError ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10">
            <Mic className="text-muted-foreground mb-3 size-8" />
            <p className="text-muted-foreground max-w-sm text-center text-sm">
              No recordings yet. Start a recording above — audio is captured and attached to this consultation.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ol className="space-y-2" data-doc="consultation-recording-list">
          {recordings.map((r) => (
            <li key={r.id}>
              <Card>
                <CardContent className="flex items-center gap-3 p-3">
                  <Mic className="text-muted-foreground size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">#{r.sequenceNumber}</span>
                      {r.durationFormatted && <span className="text-muted-foreground text-xs">{r.durationFormatted}</span>}
                      {(r.rawMediaId || r.processedMediaId) && (
                        <Badge variant="secondary" className="gap-1 text-[10px]" data-doc="consultation-recording-dual-capture">
                          <Layers className="size-3" />
                          Dual capture
                        </Badge>
                      )}
                      {r.language && (
                        <Badge variant="outline" className="text-[10px]">
                          {r.language}
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground truncate font-mono text-xs">
                      {r.rawMediaId ? `raw: ${r.rawMediaId.slice(0, 8)} · ` : ''}
                      {r.processedMediaId ? `proc: ${r.processedMediaId.slice(0, 8)} · ` : ''}
                      {r.mediaId.slice(0, 8)}
                    </p>
                  </div>
                  <span className="text-muted-foreground shrink-0 text-[11px]">
                    {r.createdAt ? formatDistanceToNow(new Date(r.createdAt), { addSuffix: true }) : ''}
                  </span>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
