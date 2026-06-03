/**
 * LOCAL (in-browser) voice-embedding UI (TASK-329 P4).
 *
 * Two cards driven by the SDK `useLocalVoiceEmbedding` hook:
 *   - <LocalEnrollCard/>: extract a WavLM speaker embedding in the browser,
 *     persist the profile via the EXISTING `/voice-profile/enroll` path, and
 *     cache the local embedding (tenant/user-scoped). Surfaces model-load /
 *     extraction progress.
 *   - <QuickTestCard/>: extract a fresh clip's embedding and cosine-compare it
 *     against the locally-enrolled embedding(s) — a match/score read-out.
 *
 * The heavy ONNX model lives entirely inside `@arcaai/vox`; this file only
 * orchestrates audio capture + the hook, so unit tests mock `@arcaai/vox`.
 */

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Progress } from '@arcaai/ui/progress';
import { Skeleton } from '@arcaai/ui/skeleton';
import { useLocalVoiceEmbedding } from '@arcaai/vox';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileAudio, Fingerprint, Loader2, Mic, ShieldCheck, Square, Upload, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type AudioSample, MAX_SAMPLES, MAX_SAMPLE_DURATION, formatDuration, getAudioDuration, toWavFile } from './audio-utils';

const STATUS_LABEL: Record<string, string> = {
  'loading-model': 'Loading voice model…',
  extracting: 'Extracting voice embedding…',
  enrolling: 'Saving voice profile…',
};

// ---------------------------------------------------------------------------
// Shared mic recorder (file upload + MediaRecorder), used by both cards.
// ---------------------------------------------------------------------------

function useMicRecorder(onClip: (blob: Blob, duration: number) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number>(0);
  const startedAtRef = useRef<number>(0);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    setIsRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = 0;
    }
    setElapsed(0);
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        try {
          const duration = await getAudioDuration(blob);
          if (duration < 0.5) {
            toast.warning('Recording too short, discarded');
            return;
          }
          onClip(blob, duration);
        } catch {
          toast.error('Failed to process recording');
        }
      };
      recorder.start();
      startedAtRef.current = Date.now();
      setIsRecording(true);
      setElapsed(0);
      timerRef.current = window.setInterval(() => {
        setElapsed((Date.now() - startedAtRef.current) / 1000);
      }, 100);
    } catch {
      toast.error('Could not access microphone');
    }
  }, [onClip]);

  // Auto-stop at the max duration.
  useEffect(() => {
    if (isRecording && elapsed >= MAX_SAMPLE_DURATION) stop();
  }, [isRecording, elapsed, stop]);

  useEffect(() => {
    return () => {
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return { isRecording, elapsed, start, stop };
}

function ProgressReadout({ status, progress }: { status: string; progress: { progress?: number; file?: string } | null }) {
  const label = STATUS_LABEL[status] ?? 'Working…';
  const pct = typeof progress?.progress === 'number' ? Math.max(0, Math.min(100, Math.round(progress.progress))) : undefined;
  return (
    <div className="space-y-2" data-testid="local-progress">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        <span>{label}</span>
        {progress?.file ? <span className="text-muted-foreground truncate text-xs">{progress.file}</span> : null}
      </div>
      {typeof pct === 'number' ? <Progress value={pct} /> : <Skeleton className="h-2 w-full" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local Enroll Card
// ---------------------------------------------------------------------------

export function LocalEnrollCard() {
  const queryClient = useQueryClient();
  const { enroll, status, progress, isBusy, error, modelId, supported, enrolled } = useLocalVoiceEmbedding();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [samples, setSamples] = useState<AudioSample[]>([]);
  const [label, setLabel] = useState('');
  const recordingCountRef = useRef(0);

  const addClip = useCallback((blob: Blob, duration: number, name: string) => {
    setSamples((prev) => (prev.length >= MAX_SAMPLES ? prev : [...prev, { id: crypto.randomUUID(), name, blob, duration }]));
  }, []);

  const recorder = useMicRecorder((blob, duration) => {
    recordingCountRef.current += 1;
    addClip(blob, duration, `Recording ${recordingCountRef.current}`);
    toast.success(`Recording added (${formatDuration(duration)})`);
  });

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    try {
      const duration = await getAudioDuration(selected);
      if (duration > MAX_SAMPLE_DURATION) {
        toast.warning(`File exceeds ${MAX_SAMPLE_DURATION}s limit (${formatDuration(duration)})`);
        return;
      }
      addClip(selected, duration, selected.name);
      toast.success(`Sample added (${formatDuration(duration)})`);
    } catch {
      toast.error('Could not read audio file');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeSample = (id: string) => setSamples((prev) => prev.filter((s) => s.id !== id));

  const handleEnroll = async () => {
    if (samples.length === 0) {
      toast.warning('Add at least one audio sample');
      return;
    }
    try {
      const wavFiles = await Promise.all(samples.map((s, i) => toWavFile(s.blob, `sample-${i + 1}.wav`)));
      await enroll(wavFiles, { label: label.trim() || undefined });
      toast.success('Voice profile enrolled locally and saved');
      setSamples([]);
      setLabel('');
      queryClient.invalidateQueries({ queryKey: ['voice-profiles'] });
    } catch (err) {
      toast.error(`Local enrollment failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const isFull = samples.length >= MAX_SAMPLES;
  const canEnroll = samples.length > 0 && supported;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Fingerprint className="size-4" />
            <CardTitle className="text-sm">Local Enrollment (in-browser)</CardTitle>
          </div>
          <Badge variant="outline" className="text-[10px]" title={modelId}>
            {modelId}
          </Badge>
        </div>
        <CardDescription className="text-xs">
          Extracts a speaker embedding on-device with Transformers.js, then saves the profile via the standard enrollment API. Audio never leaves the
          browser for embedding.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!supported && (
          <div className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            In-browser extraction isn’t supported in this environment. Use the server provider instead.
          </div>
        )}

        <input ref={fileInputRef} type="file" accept="audio/*" onChange={handleFileChange} className="hidden" aria-label="Upload audio file for local voice enrollment" />

        <div className="space-y-3">
          <Label className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">1. Add Audio Samples</Label>
          {recorder.isRecording ? (
            <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-950">
              <span className="text-sm font-medium text-red-700 dark:text-red-300">Recording… {formatDuration(recorder.elapsed)}</span>
              <Button variant="destructive" size="sm" onClick={recorder.stop} className="gap-1.5">
                <Square className="size-3" />
                Stop
              </Button>
            </div>
          ) : !isFull ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={() => fileInputRef.current?.click()} disabled={isBusy || !supported}>
                <Upload className="size-3.5" />
                Upload File
              </Button>
              <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={recorder.start} disabled={isBusy || !supported}>
                <Mic className="size-3.5" />
                Record Voice
              </Button>
            </div>
          ) : (
            <div className="text-muted-foreground rounded-lg border border-dashed bg-muted/10 px-4 py-3 text-center text-sm">Maximum sample limit reached.</div>
          )}

          <div className="space-y-2">
            {samples.length === 0 ? (
              <p className="text-muted-foreground text-xs">No samples yet. Add 1–{MAX_SAMPLES} short clips.</p>
            ) : (
              samples.map((sample, i) => (
                <div key={sample.id} className="bg-background flex items-center justify-between rounded-md border px-3 py-2">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <FileAudio className="text-primary size-4 shrink-0" />
                    <span className="truncate text-sm font-medium">{sample.name}</span>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {formatDuration(sample.duration)}
                    </Badge>
                  </div>
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive ml-2 size-7 shrink-0" onClick={() => removeSample(sample.id)} disabled={isBusy} aria-label={`Remove sample ${i + 1}`}>
                    <XCircle className="size-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="local-voice-label" className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            2. Profile Label (Optional)
          </Label>
          <Input id="local-voice-label" value={label} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)} disabled={isBusy} className="text-sm" placeholder="e.g. Clinic mic" />
        </div>

        {isBusy ? <ProgressReadout status={status} progress={progress} /> : null}
        {error && !isBusy ? <p className="text-destructive text-xs">{error.message}</p> : null}

        <Button onClick={handleEnroll} disabled={!canEnroll || isBusy} className="w-full gap-2 sm:w-auto">
          {isBusy ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {STATUS_LABEL[status] ?? 'Working…'}
            </>
          ) : (
            <>
              <Fingerprint className="size-4" />
              Enroll Locally
            </>
          )}
        </Button>

        {enrolled.length > 0 ? (
          <p className="text-muted-foreground text-xs" data-testid="local-enrolled-count">
            {enrolled.length} local embedding{enrolled.length !== 1 ? 's' : ''} cached for quick test.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Quick Test Card
// ---------------------------------------------------------------------------

export function QuickTestCard() {
  const { quickTest, enrolled, status, progress, isBusy, supported } = useLocalVoiceEmbedding();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recordingCountRef = useRef(0);
  const [result, setResult] = useState<{ profileId: string; score: number; isMatch: boolean; threshold: number } | null>(null);
  const [tested, setTested] = useState(false);

  const runTest = useCallback(
    async (clip: Blob) => {
      try {
        const res = await quickTest(clip);
        setResult(res);
        setTested(true);
        if (!res) toast.warning('Enroll a voice locally before running a quick test');
      } catch (err) {
        toast.error(`Quick test failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
    [quickTest],
  );

  const recorder = useMicRecorder((blob) => {
    recordingCountRef.current += 1;
    void runTest(blob);
  });

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    await runTest(selected);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const hasEnrolled = enrolled.length > 0;
  const scorePct = result ? (result.score * 100).toFixed(1) : null;
  // F9 — surface a human-readable profile label for the closest match instead
  // of the raw profileId UUID; fall back to a shortened id when unlabeled.
  const matchedLabel = result
    ? (() => {
        const label = enrolled.find((e) => e.profileId === result.profileId)?.label?.trim();
        if (label) return label;
        return result.profileId.length > 12 ? `${result.profileId.slice(0, 8)}…` : result.profileId;
      })()
    : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4" />
          <CardTitle className="text-sm">Quick Test (speaker match)</CardTitle>
        </div>
        <CardDescription className="text-xs">
          Record or upload a short clip; it’s compared (cosine similarity) against your locally-enrolled voice to validate diarization / user-voice detection.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <input ref={fileInputRef} type="file" accept="audio/*" onChange={handleFileChange} className="hidden" aria-label="Upload audio file for quick test" />

        {!hasEnrolled ? (
          <p className="text-muted-foreground text-sm" data-testid="quick-test-empty">
            No locally-enrolled voice yet. Enroll with the Local provider first.
          </p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={() => fileInputRef.current?.click()} disabled={isBusy || !supported}>
              <Upload className="size-3.5" />
              Upload Clip
            </Button>
            {recorder.isRecording ? (
              <Button variant="destructive" size="sm" className="flex-1 gap-1.5" onClick={recorder.stop}>
                <Square className="size-3" />
                Stop ({formatDuration(recorder.elapsed)})
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={recorder.start} disabled={isBusy || !supported}>
                <Mic className="size-3.5" />
                Record Clip
              </Button>
            )}
          </div>
        )}

        {isBusy ? <ProgressReadout status={status} progress={progress} /> : null}

        {tested && result ? (
          <div className="rounded-lg border p-4" data-testid="quick-test-result">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold tabular-nums">{scorePct}%</p>
                <p className="text-muted-foreground text-xs">cosine similarity · threshold {(result.threshold * 100).toFixed(0)}%</p>
              </div>
              {result.isMatch ? (
                <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
                  <CheckCircle2 className="size-3.5" />
                  Match
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <XCircle className="size-3.5" />
                  No match
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-2 text-xs">Closest profile: {matchedLabel}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
