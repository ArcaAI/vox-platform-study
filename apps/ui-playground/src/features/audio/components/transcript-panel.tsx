import { recordSpeakerObservation, resolveSpeakerLabel } from '@/features/audio/lib/speaker-profiles';
import { upsertTranscriptEntry } from '@/features/audio/lib/transcript-state';
import { useRealtimeTranscription } from '@/hooks/use-realtime-transcription';
import { cn } from '@/lib/utils';
import { useAudioStore, type MicrophoneSource, type TranscriptEntry, type WordTimestamp } from '@/store/audio-store';
import { usePlaygroundStore } from '@/store/playground-store';
import { RoomProvider, useAudioTrack } from '@arcaai/room';
import type { TranscriptionResult, TranscriptionTimestamp } from '@arcaai/stt';
import { useSTT } from '@arcaai/stt';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { LiveWaveform } from '@arcaai/ui/components/elevenlabs/live-waveform';
import { Progress } from '@arcaai/ui/progress';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { createVAD } from '@arcaai/vad';
import { Brain, Download, HardDrive, Languages, Mic, MicOff, Plug, RefreshCw, Server, Trash2, Wifi, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DEFAULT_TRANSCRIPTION_PIPELINE_ID } from '../constants';
import { AudioTranscriptItem } from './audio-transcript-item';
import { LiveSpectrogram } from './live-spectrogram';

type ExtendedTranscriptionResult = TranscriptionResult & {
  speakerConfidence?: number;
  speakerFeatures?: TranscriptEntry['speakerFeatures'];
};

const LOCAL_AUDIO_SAMPLE_RATE = 16000;
const MAX_VAD_SEGMENT_SECONDS = 6;
const VAD_SEGMENT_OVERLAP_SECONDS = 0.25;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function splitSpeechSegmentForRealtime(audio: Float32Array, maxSeconds = MAX_VAD_SEGMENT_SECONDS, overlapSeconds = VAD_SEGMENT_OVERLAP_SECONDS) {
  const maxSamples = Math.max(1, Math.floor(maxSeconds * LOCAL_AUDIO_SAMPLE_RATE));
  if (audio.length <= maxSamples) {
    return [{ audio, offsetSec: 0 }];
  }

  const overlapSamples = Math.max(0, Math.floor(overlapSeconds * LOCAL_AUDIO_SAMPLE_RATE));
  const chunks: Array<{ audio: Float32Array; offsetSec: number }> = [];
  let startSample = 0;

  while (startSample < audio.length) {
    const endSample = Math.min(audio.length, startSample + maxSamples);
    const chunkAudio = audio.slice(startSample, endSample);
    chunks.push({
      audio: chunkAudio,
      offsetSec: startSample / LOCAL_AUDIO_SAMPLE_RATE,
    });
    if (endSample >= audio.length) {
      break;
    }
    startSample = Math.max(0, endSample - overlapSamples);
  }

  return chunks;
}

function toWordTimestamps(timestamps: TranscriptionTimestamp[] | undefined, offsetSec: number): WordTimestamp[] | undefined {
  if (!timestamps || timestamps.length === 0) {
    return undefined;
  }
  return timestamps.map((item) => ({
    word: item.text,
    start: parseFloat(Math.max(0, item.start + offsetSec).toFixed(3)),
    end: parseFloat(Math.max(0, item.end + offsetSec).toFixed(3)),
    confidence: (item as { confidence?: number }).confidence ?? 1.0,
  }));
}

function useTranscriptSegmentPlayback() {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recorderMimeTypeRef = useRef('audio/webm');
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const stableRecordingUrlRef = useRef<string | null>(null);
  const temporaryPlaybackUrlRef = useRef<string | null>(null);

  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [capturedBytes, setCapturedBytes] = useState(0);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  const persistRecordingUrl = useCallback(() => {
    if (stableRecordingUrlRef.current) {
      URL.revokeObjectURL(stableRecordingUrlRef.current);
      stableRecordingUrlRef.current = null;
    }
    if (chunksRef.current.length === 0) {
      setRecordedAudioUrl(null);
      return null;
    }
    const blob = new Blob(chunksRef.current, { type: recorderMimeTypeRef.current });
    const nextUrl = URL.createObjectURL(blob);
    stableRecordingUrlRef.current = nextUrl;
    setRecordedAudioUrl(nextUrl);
    return nextUrl;
  }, []);

  const startCapture = useCallback(
    (stream: MediaStream | null) => {
      if (!stream) return;
      if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return;

      const activeRecorder = recorderRef.current;
      if (activeRecorder && activeRecorder.state !== 'inactive') {
        return;
      }

      if (recordedStreamRef.current !== stream) {
        chunksRef.current = [];
        setCapturedBytes(0);
        setRecordedAudioUrl(null);
        if (stableRecordingUrlRef.current) {
          URL.revokeObjectURL(stableRecordingUrlRef.current);
          stableRecordingUrlRef.current = null;
        }
      }

      const preferredMimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      const selectedMimeType = preferredMimeTypes.find((mimeType) => MediaRecorder.isTypeSupported?.(mimeType));
      const recorder = selectedMimeType ? new MediaRecorder(stream, { mimeType: selectedMimeType }) : new MediaRecorder(stream);

      recorderMimeTypeRef.current = recorder.mimeType || selectedMimeType || recorderMimeTypeRef.current;
      recordedStreamRef.current = stream;
      setReplayError(null);

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        chunksRef.current.push(event.data);
        setCapturedBytes((prev) => prev + event.data.size);
      };

      recorder.onstop = () => {
        persistRecordingUrl();
      };

      recorder.start(750);
      recorderRef.current = recorder;
    },
    [persistRecordingUrl],
  );

  const stopCapture = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      persistRecordingUrl();
    }
  }, [persistRecordingUrl]);

  const stopPlayback = useCallback(() => {
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.src = '';
      audioElementRef.current = null;
    }
    if (temporaryPlaybackUrlRef.current) {
      URL.revokeObjectURL(temporaryPlaybackUrlRef.current);
      temporaryPlaybackUrlRef.current = null;
    }
    setActiveSegmentId(null);
  }, []);

  const playSegment = useCallback(
    async (entry: TranscriptEntry) => {
      if (entry.end <= entry.start) return;

      setReplayError(null);
      stopPlayback();

      let playbackUrl = stableRecordingUrlRef.current;
      let usingTemporarySnapshot = false;

      if (!playbackUrl && chunksRef.current.length > 0) {
        const snapshotBlob = new Blob(chunksRef.current, { type: recorderMimeTypeRef.current });
        playbackUrl = URL.createObjectURL(snapshotBlob);
        temporaryPlaybackUrlRef.current = playbackUrl;
        usingTemporarySnapshot = true;
      }

      if (!playbackUrl) {
        setReplayError('No recorded audio available yet.');
        return;
      }

      const audio = new Audio(playbackUrl);
      audioElementRef.current = audio;

      try {
        await new Promise<void>((resolve, reject) => {
          audio.onloadedmetadata = () => resolve();
          audio.onerror = () => reject(new Error('Failed to load recorded audio.'));
        });

        const rawStart = Math.max(0, entry.start);
        const rawEnd = Math.max(rawStart + 0.2, entry.end);
        const audioDuration = Number.isFinite(audio.duration) ? audio.duration : rawEnd;
        const startSec = Math.min(rawStart, Math.max(0, audioDuration - 0.2));
        const endSec = Math.min(rawEnd, audioDuration);

        const stopAtBoundary = () => {
          if (audio.currentTime >= endSec) {
            audio.pause();
            audio.removeEventListener('timeupdate', stopAtBoundary);
            setActiveSegmentId(null);
            if (usingTemporarySnapshot && temporaryPlaybackUrlRef.current) {
              URL.revokeObjectURL(temporaryPlaybackUrlRef.current);
              temporaryPlaybackUrlRef.current = null;
            }
          }
        };

        audio.addEventListener('timeupdate', stopAtBoundary);
        audio.onended = () => {
          setActiveSegmentId(null);
          audio.removeEventListener('timeupdate', stopAtBoundary);
          if (usingTemporarySnapshot && temporaryPlaybackUrlRef.current) {
            URL.revokeObjectURL(temporaryPlaybackUrlRef.current);
            temporaryPlaybackUrlRef.current = null;
          }
        };

        audio.currentTime = startSec;
        setActiveSegmentId(entry.id);
        await audio.play();
      } catch (error) {
        setActiveSegmentId(null);
        setReplayError(error instanceof Error ? error.message : 'Unable to replay this segment.');
      }
    },
    [stopPlayback],
  );

  const clearRecording = useCallback(() => {
    stopPlayback();
    chunksRef.current = [];
    recordedStreamRef.current = null;
    setCapturedBytes(0);
    setReplayError(null);
    if (stableRecordingUrlRef.current) {
      URL.revokeObjectURL(stableRecordingUrlRef.current);
      stableRecordingUrlRef.current = null;
    }
    setRecordedAudioUrl(null);
  }, [stopPlayback]);

  useEffect(() => {
    return () => {
      stopCapture();
      clearRecording();
    };
  }, [clearRecording, stopCapture]);

  return {
    startCapture,
    stopCapture,
    playSegment,
    stopPlayback,
    clearRecording,
    activeSegmentId,
    replayError,
    hasRecordedAudio: capturedBytes > 0 || Boolean(recordedAudioUrl),
  };
}

function TranscriptList({
  entries,
  emptyMessage,
  onPlaySegment,
  activeSegmentId,
}: {
  entries: TranscriptEntry[];
  emptyMessage: string;
  onPlaySegment?: (entry: TranscriptEntry) => void;
  activeSegmentId?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [entries.length]);

  return (
    <ScrollArea className="h-96 rounded-lg border" ref={scrollRef}>
      {entries.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center py-16 text-center">
          <Languages className="text-muted-foreground mb-3 size-10" />
          <p className="text-muted-foreground text-sm">{emptyMessage}</p>
        </div>
      ) : (
        <div className="space-y-1 p-2">
          {entries.map((entry) => (
            <AudioTranscriptItem
              key={entry.id}
              entry={entry}
              onPlaySegment={onPlaySegment}
              isActiveSegment={activeSegmentId === entry.id}
              showSegmentBadge
              showTimingDetails
              showWordTimestamps
            />
          ))}
        </div>
      )}
    </ScrollArea>
  );
}

function WsStatusBadge({ status }: { status: string }) {
  const variants: Record<string, { variant: 'default' | 'destructive' | 'outline' | 'secondary'; icon: typeof Wifi }> = {
    idle: { variant: 'outline', icon: WifiOff },
    creating_session: { variant: 'secondary', icon: RefreshCw },
    connecting: { variant: 'secondary', icon: RefreshCw },
    streaming: { variant: 'default', icon: Wifi },
    reconnecting: { variant: 'secondary', icon: RefreshCw },
    stopping: { variant: 'secondary', icon: RefreshCw },
    error: { variant: 'destructive', icon: WifiOff },
  };
  const cfg = variants[status] ?? variants.idle;
  const Icon = cfg.icon;
  const isAnimated = ['creating_session', 'connecting', 'reconnecting', 'stopping'].includes(status);
  return (
    <Badge variant={cfg.variant} className="gap-1 text-[10px]">
      <Icon className={cn('size-2.5', isAnimated && 'animate-spin')} />
      {status.replace('_', ' ')}
    </Badge>
  );
}

type PreparedMixedInput = {
  stream: MediaStream;
  cleanup: () => void;
};

function buildAudioConstraints(deviceId: string | undefined, sampleRate: number): MediaTrackConstraints | true {
  const hasDeviceId = deviceId != null && deviceId.trim().length > 0;
  if (!hasDeviceId) return true;
  return { deviceId: { exact: deviceId }, sampleRate };
}

async function prepareMixedMicrophoneStream(micSources: MicrophoneSource[]): Promise<PreparedMixedInput> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const destination = ctx.createMediaStreamDestination();
  const acquiredStreams: MediaStream[] = [];
  const sourceNodes: MediaStreamAudioSourceNode[] = [];
  const gainNodes: GainNode[] = [];

  try {
    for (const mic of micSources) {
      if (mic.muted) continue;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: buildAudioConstraints(mic.deviceId, 16000),
      });
      acquiredStreams.push(stream);

      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = mic.gain;
      source.connect(gain);
      gain.connect(destination);
      sourceNodes.push(source);
      gainNodes.push(gain);
    }

    if (acquiredStreams.length === 0) {
      throw new Error('No active microphones available for mixing');
    }

    const cleanup = () => {
      sourceNodes.forEach((node) => node.disconnect());
      gainNodes.forEach((node) => node.disconnect());
      acquiredStreams.forEach((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      });
      if (ctx.state !== 'closed') {
        ctx.close().catch(() => {});
      }
    };

    return { stream: destination.stream, cleanup };
  } catch (error) {
    acquiredStreams.forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });
    sourceNodes.forEach((node) => node.disconnect());
    gainNodes.forEach((node) => node.disconnect());
    if (ctx.state !== 'closed') {
      await ctx.close().catch(() => {});
    }
    throw error;
  }
}

function BackendSocketTranscript() {
  const { sources, isMixing, noiseFilterEnabled, selectedPipelineId } = useAudioStore();
  const realtime = useRealtimeTranscription();
  const segmentPlayback = useTranscriptSegmentPlayback();
  const micSources = sources.filter((s): s is MicrophoneSource => s.type === 'microphone');
  const shouldUseMixedInput = isMixing || micSources.length > 1;
  const mixedInputCleanupRef = useRef<(() => void) | null>(null);

  const releaseMixedInput = useCallback(() => {
    mixedInputCleanupRef.current?.();
    mixedInputCleanupRef.current = null;
    useAudioStore.getState().setMixedStream(null);
  }, []);

  const startStream = useCallback(async () => {
    toast.info('Creating streaming session...');
    releaseMixedInput();
    let preparedMixedInput: PreparedMixedInput | null = null;
    try {
      if (shouldUseMixedInput) {
        preparedMixedInput = await prepareMixedMicrophoneStream(micSources);
        useAudioStore.getState().setMixedStream(preparedMixedInput.stream);
      }

      await realtime.start({
        pipelineId: selectedPipelineId || DEFAULT_TRANSCRIPTION_PIPELINE_ID,
        sampleRate: 16000,
        deviceId: preparedMixedInput ? undefined : micSources[0]?.deviceId,
        stream: preparedMixedInput?.stream,
        echoCancellation: true,
        noiseSuppression: noiseFilterEnabled,
        autoGainControl: true,
      });
      mixedInputCleanupRef.current = preparedMixedInput?.cleanup ?? null;
      toast.success(`WebSocket connected (session: ${realtime.sessionId?.slice(0, 12) ?? ''}...)`);
    } catch (err) {
      preparedMixedInput?.cleanup();
      useAudioStore.getState().setMixedStream(null);
      toast.error(`Failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [micSources, realtime, shouldUseMixedInput, noiseFilterEnabled, selectedPipelineId]);

  const stopStream = useCallback(async () => {
    await realtime.stop();
    releaseMixedInput();
    toast.info('WebSocket stream closed');
  }, [realtime, releaseMixedInput]);

  useEffect(() => {
    return () => {
      releaseMixedInput();
    };
  }, [releaseMixedInput]);

  useEffect(() => {
    if (!realtime.isStreaming && mixedInputCleanupRef.current) {
      releaseMixedInput();
    }
  }, [realtime.isStreaming, releaseMixedInput]);

  useEffect(() => {
    useAudioStore.getState().setCapturing(realtime.isStreaming);
  }, [realtime.isStreaming]);

  useEffect(() => {
    if (realtime.isStreaming && realtime.inputStream) {
      segmentPlayback.startCapture(realtime.inputStream);
    } else {
      segmentPlayback.stopCapture();
    }
  }, [realtime.isStreaming, realtime.inputStream, segmentPlayback.startCapture, segmentPlayback.stopCapture]);

  const handleClear = useCallback(() => {
    realtime.clearTranscripts();
    if (!realtime.isStreaming) {
      segmentPlayback.clearRecording();
    }
  }, [realtime, segmentPlayback.clearRecording]);

  const finalCount = realtime.transcripts.filter((t) => t.isFinal).length;
  const wordCount = realtime.transcripts.filter((t) => t.isFinal).reduce((acc, t) => acc + t.text.split(/\s+/).length, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <WsStatusBadge status={realtime.status} />
          {realtime.sessionId && <code className="bg-muted rounded px-1.5 text-[10px]">{realtime.sessionId.slice(0, 16)}</code>}
          <span className="text-muted-foreground text-[10px]">
            {formatBytes(realtime.bytesSent)} sent | {finalCount} segments | {wordCount} words
          </span>
          {segmentPlayback.hasRecordedAudio && (
            <Badge variant="secondary" className="text-[10px]">
              Segment replay ready
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleClear} disabled={realtime.transcripts.length === 0}>
            <Trash2 className="mr-1 size-3" /> Clear
          </Button>
          {!realtime.isStreaming && !['creating_session', 'connecting'].includes(realtime.status) ? (
            <Button size="sm" onClick={startStream} className="gap-1.5" disabled={micSources.length === 0}>
              <Plug className="size-3.5" />
              Connect & Stream
            </Button>
          ) : (
            <Button variant="destructive" size="sm" onClick={stopStream} className="gap-1.5">
              <MicOff className="size-3.5" />
              Disconnect
            </Button>
          )}
        </div>
      </div>

      {realtime.isStreaming && (
        <div className="bg-muted/30 overflow-hidden rounded-lg border p-1">
          <LiveWaveform
            active={realtime.isStreaming}
            processing={['creating_session', 'connecting'].includes(realtime.status)}
            deviceId={shouldUseMixedInput ? undefined : micSources[0]?.deviceId}
            height={40}
            barWidth={2}
            barGap={1}
            barRadius={1}
            sensitivity={1.5}
            mode="static"
            className="text-primary"
          />
        </div>
      )}

      {realtime.isStreaming && realtime.inputStream && (
        <LiveSpectrogram stream={realtime.inputStream} active={realtime.isStreaming} label="Live Input Stream" />
      )}

      {segmentPlayback.replayError && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2">
          <p className="text-amber-700 text-[11px]">{segmentPlayback.replayError}</p>
        </div>
      )}

      {realtime.error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2">
          <p className="text-destructive text-[11px]">{realtime.error}</p>
        </div>
      )}

      <TranscriptList
        entries={realtime.transcripts}
        emptyMessage={realtime.isStreaming ? 'Listening for speech via WebSocket...' : 'Click "Connect & Stream" to begin real-time transcription.'}
        onPlaySegment={segmentPlayback.playSegment}
        activeSegmentId={segmentPlayback.activeSegmentId}
      />
    </div>
  );
}

function useModelCacheStatus(modelId: string) {
  const [cacheStatus, setCacheStatus] = useState<{ cached: boolean; files: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const keys = await caches.keys();
        let count = 0;
        for (const key of keys) {
          if (key.includes('transformers')) {
            const cache = await caches.open(key);
            const requests = await cache.keys();
            count += requests.filter((r) => r.url.includes(modelId.replace('/', '%2F')) || r.url.includes(modelId)).length;
          }
        }
        if (!cancelled) {
          setCacheStatus({ cached: count > 0, files: count });
        }
      } catch {
        if (!cancelled) setCacheStatus({ cached: false, files: 0 });
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, [modelId]);

  return cacheStatus;
}

function LocalAITranscriptInner({ onRetry }: { onRetry?: () => void }) {
  const { language, whisperModel, sources, isMixing, noiseFilterEnabled, diarizationEnabled, vadEnabled, vadThreshold, codeSwitchingEnabled } =
    useAudioStore();
  const debugMode = usePlaygroundStore((s) => s.debugMode);
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const transcriptIdRef = useRef(0);
  const captureStartedAtRef = useRef<number | null>(null);
  const timelineSecRef = useRef(0);
  const speechStartMsRef = useRef<number | null>(null);
  const captureSessionRef = useRef(0);
  const transcriptionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const vadProcessorRef = useRef<ReturnType<typeof createVAD> | null>(null);
  const vadContextRef = useRef<AudioContext | null>(null);
  const [vadIsReady, setVadIsReady] = useState(false);
  const [vadIsSpeaking, setVadIsSpeaking] = useState(false);
  const [vadSpeechProbability, setVadSpeechProbability] = useState(0);
  const vadSpeechProbabilityRef = useRef(0);
  const vadUiUpdatedAtRef = useRef(0);
  const [vadSegmentCount, setVadSegmentCount] = useState(0);
  const cacheStatus = useModelCacheStatus(whisperModel);
  const segmentPlayback = useTranscriptSegmentPlayback();
  const vadGatedMode = vadEnabled;

  const micSources = sources.filter((s): s is MicrophoneSource => s.type === 'microphone');

  const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
    noiseSuppression: noiseFilterEnabled,
    echoCancellation: true,
    autoGainControl: true,
    deviceId: micSources[0]?.deviceId,
  });

  const localInputStream = useMemo(() => {
    const sourceTrack = track?.sourceMediaStreamTrack;
    if (!sourceTrack) return null;
    return new MediaStream([sourceTrack]);
  }, [track]);

  const resolvedLanguage = useMemo(() => (codeSwitchingEnabled ? 'auto' : language || 'en-US'), [codeSwitchingEnabled, language]);

  const segmentCounterRef = useRef(0);

  const updateVadSpeechProbability = useCallback((nextValue: unknown) => {
    const probability = typeof nextValue === 'number' && Number.isFinite(nextValue) ? Math.max(0, Math.min(1, nextValue)) : nextValue ? 1 : 0;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const changed = Math.abs(vadSpeechProbabilityRef.current - probability) >= 0.05;
    const shouldFlush = now - vadUiUpdatedAtRef.current >= 120;

    vadSpeechProbabilityRef.current = probability;
    if (!changed && !shouldFlush) {
      return;
    }

    vadUiUpdatedAtRef.current = now;
    setVadSpeechProbability(probability);
  }, []);

  const appendFinalEntry = useCallback((result: TranscriptionResult, segmentStartSec: number, segmentEndSec: number) => {
    const enriched = result as ExtendedTranscriptionResult;
    transcriptIdRef.current += 1;
    segmentCounterRef.current += 1;
    const start = parseFloat(segmentStartSec.toFixed(3));
    const end = parseFloat(segmentEndSec.toFixed(3));
    const duration = parseFloat((end - start).toFixed(3));
    const inference = parseFloat(((result.latencyMs ?? 0) / 1000).toFixed(4));
    const speakerId = result.speakerId?.trim() || undefined;
    const speakerProfile = speakerId
      ? recordSpeakerObservation({
          route: 'local',
          speakerId,
          speakerConfidence: enriched.speakerConfidence,
          startTime: start,
          endTime: end,
          text: result.text,
          features: enriched.speakerFeatures,
        })
      : null;
    const speakerLabel = resolveSpeakerLabel(speakerId, speakerProfile?.label);
    const entry: TranscriptEntry = {
      id: `whisper-${transcriptIdRef.current}`,
      segment: segmentCounterRef.current,
      text: result.text,
      timestamp: Date.now(),
      isFinal: true,
      speaker: speakerId,
      speakerLabel,
      speakerConfidence: enriched.speakerConfidence,
      speakerFeatures: enriched.speakerFeatures,
      start,
      end,
      duration,
      inference,
      wordTimestamps: toWordTimestamps(result.timestamps, segmentStartSec),
    };
    setTranscriptEntries((prev) => upsertTranscriptEntry(prev, entry));
  }, []);

  const sttOptions = useMemo(
    () => ({
      track,
      autoAttach: true,
      debugMode,
      audio: {
        language: resolvedLanguage,
        chunkLengthS: vadGatedMode ? 2 : 5,
        overlapLengthS: vadGatedMode ? 0.2 : 1,
      },
      features: {
        provider: 'local' as const,
        modelId: whisperModel,
        device: 'auto' as const,
        quantized: true,
        diarization: diarizationEnabled,
        numSpeakers: 2,
        returnTimestamps: 'word' as const,
        codeSwitching: codeSwitchingEnabled,
        vadGate: vadGatedMode,
      },
      onTranscription: (result: TranscriptionResult) => {
        if (vadGatedMode) {
          return;
        }
        const elapsedSec = captureStartedAtRef.current ? Math.max(0, (Date.now() - captureStartedAtRef.current) / 1000) : timelineSecRef.current;
        const durationSec = Math.max(0.4, result.duration ?? 0);
        const segmentEndSec = Math.max(elapsedSec, timelineSecRef.current + durationSec);
        const segmentStartSec = Math.max(0, segmentEndSec - durationSec);
        timelineSecRef.current = segmentEndSec;
        appendFinalEntry(result, segmentStartSec, segmentEndSec);
      },
      onPartialTranscription: (result: TranscriptionResult) => {
        if (vadGatedMode) {
          return;
        }
        transcriptIdRef.current += 1;
        const entry: TranscriptEntry = {
          id: `whisper-partial-${transcriptIdRef.current}`,
          segment: segmentCounterRef.current + 1,
          text: result.text,
          timestamp: Date.now(),
          isFinal: false,
          start: 0,
          end: 0,
          duration: 0,
          inference: 0,
        };
        setTranscriptEntries((prev) => upsertTranscriptEntry(prev, entry));
      },
    }),
    [track, resolvedLanguage, whisperModel, diarizationEnabled, codeSwitchingEnabled, vadGatedMode, appendFinalEntry, debugMode],
  );

  const {
    isReady,
    isProcessing,
    isLoading,
    currentTranscript,
    loadProgress,
    error: sttError,
    transcribeSegment,
    processor: sttProcessor,
  } = useSTT(sttOptions);

  useEffect(() => {
    sttProcessor?.setDebugMode(debugMode);
  }, [sttProcessor, debugMode]);

  const destroyVadSidecar = useCallback(() => {
    const vadProcessor = vadProcessorRef.current;
    vadProcessorRef.current = null;
    if (vadProcessor) {
      vadProcessor.destroy().catch(() => {});
    }

    const vadContext = vadContextRef.current;
    vadContextRef.current = null;
    if (vadContext && vadContext.state !== 'closed') {
      vadContext.close().catch(() => {});
    }

    speechStartMsRef.current = null;
    vadSpeechProbabilityRef.current = 0;
    vadUiUpdatedAtRef.current = 0;
    setVadIsReady(false);
    setVadIsSpeaking(false);
    setVadSpeechProbability(0);
  }, []);

  const enqueueSpeechSegment = useCallback(
    (audio: Float32Array, segmentStartSec: number, segmentEndSec: number, captureSessionId: number) => {
      const chunks = splitSpeechSegmentForRealtime(audio);
      for (const chunk of chunks) {
        transcriptionQueueRef.current = transcriptionQueueRef.current
          .then(async () => {
            if (captureSessionRef.current !== captureSessionId) {
              return;
            }
            const result = await transcribeSegment(chunk.audio);
            if (captureSessionRef.current !== captureSessionId) {
              return;
            }
            const chunkStartSec = segmentStartSec + chunk.offsetSec;
            const chunkEndSec = Math.min(segmentEndSec, chunkStartSec + chunk.audio.length / LOCAL_AUDIO_SAMPLE_RATE);
            appendFinalEntry(result, chunkStartSec, Math.max(chunkStartSec + 0.2, chunkEndSec));
          })
          .catch((error) => {
            console.error('[TranscriptPanel] VAD-gated transcription failed:', error);
            const msg = error instanceof Error ? error.message : String(error);
            toast.error(`Transcription failed: ${msg.slice(0, 120)}`);
          });
      }
    },
    [appendFinalEntry, transcribeSegment],
  );

  const handleToggleCapture = useCallback(async () => {
    if (isCapturing) {
      await stopCapture();
      segmentPlayback.stopCapture();
      destroyVadSidecar();
      useAudioStore.getState().setCapturing(false);
    } else {
      if (isMixing && micSources.length > 1) {
        toast.info('Local mode supports single-mic capture. Switch to Backend mode for true multi-mic mixing.');
      }
      await startCapture();
    }
  }, [destroyVadSidecar, isCapturing, isMixing, micSources.length, segmentPlayback.stopCapture, startCapture, stopCapture]);

  useEffect(() => {
    useAudioStore.getState().setCapturing(isCapturing);
  }, [isCapturing]);

  useEffect(() => {
    if (isCapturing && captureStartedAtRef.current == null) {
      captureStartedAtRef.current = Date.now();
      timelineSecRef.current = 0;
      captureSessionRef.current += 1;
      setVadSegmentCount(0);
      transcriptionQueueRef.current = Promise.resolve();
    }
    if (!isCapturing) {
      captureStartedAtRef.current = null;
      captureSessionRef.current += 1;
      speechStartMsRef.current = null;
    }
  }, [isCapturing]);

  useEffect(() => {
    if (!isCapturing || !vadGatedMode || !track?.sourceMediaStreamTrack) {
      destroyVadSidecar();
      return;
    }

    const sourceTrack = track.sourceMediaStreamTrack;
    let disposed = false;
    const currentSessionId = captureSessionRef.current;

    const initVad = async () => {
      destroyVadSidecar();
      const vadContext = new AudioContext({ sampleRate: LOCAL_AUDIO_SAMPLE_RATE });
      vadContextRef.current = vadContext;
      const positiveThreshold = Math.min(0.9, Math.max(0.2, vadThreshold));
      const negativeThreshold = Math.max(0.1, Math.min(0.8, positiveThreshold - 0.15));

      const vadProcessor = createVAD({
        model: 'v5',
        positiveSpeechThreshold: positiveThreshold,
        negativeSpeechThreshold: negativeThreshold,
        minSpeechMs: 180,
        redemptionMs: 600,
        preSpeechPadMs: 120,
        postSpeechPadMs: 180,
        submitUserSpeechOnPause: true,
        onSpeechStart: () => {
          speechStartMsRef.current = Date.now();
          setVadIsSpeaking(true);
        },
        onFrameProcessed: ({ isSpeech }) => {
          updateVadSpeechProbability(isSpeech);
        },
        onSpeechEnd: (audio: Float32Array) => {
          const captureStartMs = captureStartedAtRef.current;
          if (captureStartMs == null) {
            return;
          }
          const endTimeMs = Date.now();
          const speechStartMs = speechStartMsRef.current ?? endTimeMs - (audio.length / LOCAL_AUDIO_SAMPLE_RATE) * 1000;
          speechStartMsRef.current = null;
          setVadIsSpeaking(false);
          setVadSegmentCount((prev) => prev + 1);
          const segmentStartSec = Math.max(0, (speechStartMs - captureStartMs) / 1000);
          const segmentEndSec = Math.max(segmentStartSec + 0.2, (endTimeMs - captureStartMs) / 1000);
          enqueueSpeechSegment(audio, segmentStartSec, segmentEndSec, currentSessionId);
        },
        onVADMisfire: () => {
          speechStartMsRef.current = null;
          setVadIsSpeaking(false);
        },
      });
      vadProcessorRef.current = vadProcessor;

      await vadProcessor.init({
        kind: 'audio',
        track: sourceTrack,
        audioContext: vadContext,
      });

      if (!disposed) {
        setVadIsReady(true);
      }
    };

    initVad().catch((error) => {
      console.error('Failed to initialize local VAD sidecar', error);
      if (!disposed) {
        setVadIsReady(false);
      }
    });

    return () => {
      disposed = true;
      destroyVadSidecar();
    };
  }, [destroyVadSidecar, enqueueSpeechSegment, isCapturing, track, updateVadSpeechProbability, vadGatedMode, vadThreshold]);

  useEffect(() => {
    if (isCapturing && localInputStream) {
      segmentPlayback.startCapture(localInputStream);
    } else {
      segmentPlayback.stopCapture();
    }
  }, [isCapturing, localInputStream, segmentPlayback.startCapture, segmentPlayback.stopCapture]);

  const handleClear = useCallback(() => {
    setTranscriptEntries([]);
    transcriptIdRef.current = 0;
    segmentCounterRef.current = 0;
    timelineSecRef.current = 0;
    captureStartedAtRef.current = isCapturing ? Date.now() : null;
    speechStartMsRef.current = null;
    setVadSegmentCount(0);
    transcriptionQueueRef.current = Promise.resolve();
    captureSessionRef.current += 1;
    segmentPlayback.clearRecording();
  }, [isCapturing, segmentPlayback.clearRecording]);

  const finalCount = transcriptEntries.filter((t) => t.isFinal).length;
  const wordCount = transcriptEntries.filter((t) => t.isFinal).reduce((acc, t) => acc + t.text.split(/\s+/).filter(Boolean).length, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="gap-1 text-[10px]">
            <Brain className="size-2.5" />
            Local Whisper (WASM)
          </Badge>
          <Badge variant={isReady ? 'default' : isLoading ? 'secondary' : 'outline'} className="text-[10px]">
            {isLoading ? 'Loading model...' : isReady ? 'Ready' : 'Idle'}
          </Badge>
          {cacheStatus && (
            <Badge variant={cacheStatus.cached ? 'secondary' : 'outline'} className="gap-1 text-[10px]">
              {cacheStatus.cached ? (
                <>
                  <HardDrive className="size-2.5" /> Cached ({cacheStatus.files} files)
                </>
              ) : (
                <>
                  <Download className="size-2.5" /> Not cached
                </>
              )}
            </Badge>
          )}
          <Badge variant={vadGatedMode ? 'default' : 'outline'} className="text-[10px]">
            {vadGatedMode ? `VAD gated${vadIsReady ? '' : ' (initializing...)'}` : 'Chunk mode'}
          </Badge>
          <Badge variant={codeSwitchingEnabled ? 'default' : 'outline'} className="text-[10px]">
            {codeSwitchingEnabled ? 'Code-switch auto' : 'Single language'}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            Word timestamps
          </Badge>
          <span className="text-muted-foreground text-[10px]">
            {finalCount} segments | {wordCount} words
          </span>
          {vadGatedMode && (
            <span className="text-muted-foreground text-[10px]">
              VAD p={vadSpeechProbability.toFixed(2)} | speech segments {vadSegmentCount}
              {vadIsSpeaking ? ' | speaking' : ''}
            </span>
          )}
          {segmentPlayback.hasRecordedAudio && (
            <Badge variant="secondary" className="text-[10px]">
              Segment replay ready
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleClear} disabled={transcriptEntries.length === 0}>
            <Trash2 className="mr-1 size-3" /> Clear
          </Button>
          <Button size="sm" variant={isCapturing ? 'destructive' : 'default'} onClick={handleToggleCapture} className="gap-1.5">
            {isCapturing ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
            {isCapturing ? 'Stop Capture' : 'Start Capture'}
          </Button>
        </div>
      </div>

      {isLoading && loadProgress && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">
              {loadProgress.status === 'downloading'
                ? `Downloading Whisper model (${whisperModel})...`
                : `Loading Whisper model (${whisperModel})${cacheStatus?.cached ? ' from cache' : ''}...`}
            </span>
            <span className="font-medium">{Math.round((loadProgress.progress ?? 0) * 100)}%</span>
          </div>
          <Progress value={(loadProgress.progress ?? 0) * 100} className="h-2" />
          {loadProgress.file && <p className="text-muted-foreground truncate text-[9px]">{loadProgress.file}</p>}
        </div>
      )}

      {isCapturing && (
        <div className="bg-muted/30 overflow-hidden rounded-lg border p-1">
          <LiveWaveform
            active={isCapturing}
            processing={isProcessing}
            height={36}
            barWidth={2}
            barGap={1}
            barRadius={1}
            mode="static"
            className="text-purple-500"
          />
        </div>
      )}

      {isCapturing && <LiveSpectrogram stream={localInputStream} active={isCapturing} label="Live Input Stream" />}

      {segmentPlayback.replayError && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2">
          <p className="text-amber-700 text-[11px]">{segmentPlayback.replayError}</p>
        </div>
      )}

      {!vadGatedMode && currentTranscript && (
        <div className="rounded-md border border-purple-500/30 bg-purple-500/5 px-3 py-2">
          <p className="text-muted-foreground text-[10px] font-medium">Live:</p>
          <p className="text-sm italic">{currentTranscript}</p>
        </div>
      )}

      {sttError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-destructive text-[11px]">{sttError.message}</p>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry} className="mt-2 gap-1.5 text-xs">
              <RefreshCw className="size-3" />
              Retry
            </Button>
          )}
        </div>
      )}

      <TranscriptList
        entries={transcriptEntries}
        emptyMessage={
          isCapturing
            ? vadGatedMode
              ? 'Listening... only detected speech segments are transcribed.'
              : 'Listening... speak to see transcription.'
            : isLoading
              ? 'Loading Whisper model...'
              : 'Click "Start Capture" to begin local transcription.'
        }
        onPlaySegment={segmentPlayback.playSegment}
        activeSegmentId={segmentPlayback.activeSegmentId}
      />
    </div>
  );
}

function LocalAITranscript() {
  const [instanceKey, setInstanceKey] = useState(0);

  const handleRetry = useCallback(() => {
    setInstanceKey((k) => k + 1);
  }, []);

  const roomKey = `local-ai-${instanceKey}`;

  return (
    <RoomProvider autoConnect key={roomKey}>
      <LocalAITranscriptInner onRetry={handleRetry} />
    </RoomProvider>
  );
}

export function TranscriptPanel() {
  const { processingMethod, sources } = useAudioStore();

  const hasMicSources = sources.some((s) => s.type === 'microphone');
  const isLocalAI = processingMethod === 'local_ai';
  const isBackendSocket = processingMethod === 'backend_socket';

  const modeLabel = isLocalAI ? 'Local Whisper' : 'Backend (WebSocket)';
  const ModeIcon = isLocalAI ? Brain : Server;
  const modeColor = isLocalAI ? 'text-purple-500' : 'text-blue-500';

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <ModeIcon className={cn('size-4', modeColor)} />
          <CardTitle className="text-sm">{modeLabel} Transcript</CardTitle>
        </div>
        <CardDescription className="text-xs">
          {isLocalAI
            ? 'On-device Whisper transcription with local capture processing and optional diarization.'
            : 'Real-time WebSocket transcription with local capture processing and backend transcription.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        {!hasMicSources && (
          <div className="flex h-60 flex-col items-center justify-center text-center">
            <Languages className="text-muted-foreground mb-3 size-10" />
            <p className="text-muted-foreground text-sm">Select a microphone to begin</p>
            <p className="text-muted-foreground mt-1 text-xs">Add a microphone source from the panel on the left to start live transcription</p>
          </div>
        )}
        {hasMicSources && isBackendSocket && <BackendSocketTranscript />}
        {hasMicSources && isLocalAI && <LocalAITranscript />}
      </CardContent>
    </Card>
  );
}
