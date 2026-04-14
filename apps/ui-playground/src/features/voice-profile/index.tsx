import { PlaygroundLayout } from '@/components/layout/playground-layout';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@arcaai/ui/dropdown-menu';
import { Input } from '@arcaai/ui/input';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/tooltip';
import {
  CheckCircle,
  FileAudio,
  Fingerprint,
  Loader2,
  Mic,
  MoreHorizontal,
  Square,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  type VoiceProfile,
  useActivateVoiceProfile,
  useDeactivateVoiceProfile,
  useDeleteVoiceProfile,
  useEnrollVoiceProfile,
  useVoiceProfiles,
} from './api/voice-profiles';
import {
  type AudioSample,
  MAX_SAMPLES,
  MAX_SAMPLE_DURATION,
  formatDuration,
  getAudioDuration,
  toWavFile,
} from './audio-utils';

// ---------------------------------------------------------------------------
// Quality helpers
// ---------------------------------------------------------------------------

function qualityLabel(score: number): { text: string; color: string } {
  if (score >= 0.8) return { text: 'Excellent', color: 'text-green-600' };
  if (score >= 0.6) return { text: 'Good', color: 'text-blue-600' };
  if (score >= 0.4) return { text: 'Fair', color: 'text-yellow-600' };
  return { text: 'Poor', color: 'text-red-600' };
}

function QualityBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const { text, color } = qualityLabel(score);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Quality</span>
        <span className={color}>
          {pct}% - {text}
        </span>
      </div>
      <div className="bg-secondary h-1.5 w-full rounded-full">
        <div
          className="h-1.5 rounded-full bg-gradient-to-r from-red-500 via-yellow-500 to-green-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Enroll Card
// ---------------------------------------------------------------------------

function EnrollCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [samples, setSamples] = useState<AudioSample[]>([]);
  const [label, setLabel] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number>(0);
  const recordingStartRef = useRef<number>(0);
  const recordingCountRef = useRef(0);

  const enroll = useEnrollVoiceProfile();
  const isFull = samples.length >= MAX_SAMPLES;
  const canEnroll = samples.length > 0;
  const isBusy = enroll.isPending;

  // Auto-stop recording at MAX_SAMPLE_DURATION
  useEffect(() => {
    if (isRecording && recordingElapsed >= MAX_SAMPLE_DURATION) {
      stopRecording();
    }
  }, [isRecording, recordingElapsed]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    try {
      const duration = await getAudioDuration(selected);
      if (duration > MAX_SAMPLE_DURATION) {
        toast.warning(`File exceeds ${MAX_SAMPLE_DURATION}s limit (${formatDuration(duration)})`);
        return;
      }
      setSamples((prev) => [
        ...prev,
        { id: crypto.randomUUID(), name: selected.name, blob: selected, duration },
      ]);
      toast.success(`Sample added (${formatDuration(duration)})`);
    } catch {
      toast.error('Could not read audio file');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      recordingChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordingChunksRef.current, { type: mediaRecorder.mimeType });
        try {
          const duration = await getAudioDuration(blob);
          if (duration < 0.5) {
            toast.warning('Recording too short, discarded');
            return;
          }
          recordingCountRef.current += 1;
          setSamples((prev) => [
            ...prev,
            { id: crypto.randomUUID(), name: `Recording ${recordingCountRef.current}`, blob, duration },
          ]);
          toast.success(`Recording added (${formatDuration(duration)})`);
        } catch {
          toast.error('Failed to process recording');
        }
      };

      mediaRecorder.start();
      recordingStartRef.current = Date.now();
      setIsRecording(true);
      setRecordingElapsed(0);
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingElapsed((Date.now() - recordingStartRef.current) / 1000);
      }, 100);
    } catch {
      toast.error('Could not access microphone');
    }
  };

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = 0;
    }
    setRecordingElapsed(0);
  }, []);

  const removeSample = useCallback((id: string) => {
    setSamples((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handleEnroll = async () => {
    if (samples.length === 0) {
      toast.warning('Add at least one audio sample');
      return;
    }
    try {
      const wavFiles = await Promise.all(
        samples.map((s, i) => toWavFile(s.blob, `sample-${i + 1}.wav`)),
      );
      enroll.mutate(
        { files: wavFiles, label: label.trim() || undefined },
        {
          onSuccess: () => {
            toast.success('Voice profile enrolled successfully');
            setSamples([]);
            setLabel('');
          },
          onError: (err) => {
            toast.error(`Enrollment failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
          },
        },
      );
    } catch {
      toast.error('Failed to process audio samples');
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Mic className="size-4" />
          <CardTitle className="text-sm">Enroll Voice Profile</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          onChange={handleFileChange}
          className="hidden"
          aria-label="Upload audio file for voice enrollment"
        />

        {/* Sample slots */}
        <div className="space-y-1.5">
          {Array.from({ length: MAX_SAMPLES }).map((_, i) => {
            const sample = samples[i];
            return sample ? (
              <div key={sample.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileAudio className="text-primary size-3.5 shrink-0" />
                  <span className="text-muted-foreground text-[10px] shrink-0">#{i + 1}</span>
                  <span className="truncate text-xs">{sample.name}</span>
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {formatDuration(sample.duration)}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={() => removeSample(sample.id)}
                  disabled={isBusy}
                >
                  <XCircle className="size-3.5" />
                </Button>
              </div>
            ) : (
              <div
                key={`empty-${i}`}
                className="flex items-center justify-center rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
              >
                Sample #{i + 1} - empty
              </div>
            );
          })}
        </div>

        {/* Recording indicator or action buttons */}
        {isRecording ? (
          <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-950">
            <span className="relative flex size-3">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex size-3 rounded-full bg-red-500" />
            </span>
            <span className="text-sm font-medium text-red-700 dark:text-red-300">
              Recording... {formatDuration(recordingElapsed)}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-[10px] text-red-500">
                auto-stop at {MAX_SAMPLE_DURATION}s
              </span>
              <Button variant="destructive" size="sm" onClick={stopRecording} className="gap-1.5">
                <Square className="size-3" />
                Stop
              </Button>
            </div>
          </div>
        ) : !isFull ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 gap-1.5"
              onClick={() => fileInputRef.current?.click()}
              disabled={isBusy}
            >
              <Upload className="size-3.5" />
              Upload File
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 gap-1.5"
              onClick={startRecording}
              disabled={isBusy}
            >
              <Mic className="size-3.5" />
              Record Voice
            </Button>
          </div>
        ) : null}

        <Input
          placeholder="Label"
          value={label}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
          disabled={isBusy}
          className="text-xs"
        />

        <Button
          onClick={handleEnroll}
          disabled={!canEnroll || isBusy}
          className="w-full gap-2"
          size="sm"
        >
          {enroll.isPending ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Extracting voice embedding...
            </>
          ) : (
            <>
              <Fingerprint className="size-3.5" />
              Enroll Voice Profile ({samples.length}/{MAX_SAMPLES} samples)
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Profile Card
// ---------------------------------------------------------------------------

function ProfileCard({ profile }: { profile: VoiceProfile }) {
  const activate = useActivateVoiceProfile();
  const deactivate = useDeactivateVoiceProfile();
  const remove = useDeleteVoiceProfile();

  const isPending = activate.isPending || deactivate.isPending || remove.isPending;

  const handleActivate = () => {
    activate.mutate(profile.id, {
      onSuccess: () => toast.success('Profile activated'),
      onError: (err) => toast.error(`Activate failed: ${err instanceof Error ? err.message : 'Unknown'}`),
    });
  };

  const handleDeactivate = () => {
    deactivate.mutate(profile.id, {
      onSuccess: () => toast.success('Profile deactivated'),
      onError: (err) => toast.error(`Deactivate failed: ${err instanceof Error ? err.message : 'Unknown'}`),
    });
  };

  const handleDelete = () => {
    remove.mutate(profile.id, {
      onSuccess: () => toast.success('Profile deleted'),
      onError: (err) => toast.error(`Delete failed: ${err instanceof Error ? err.message : 'Unknown'}`),
    });
  };

  return (
    <Card className={profile.isActive ? 'border-primary/50 bg-primary/5' : ''}>
      <CardContent className="flex items-start justify-between gap-3 pt-4 pb-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{profile.label || 'Unnamed Profile'}</span>
            {profile.isActive && (
              <Badge variant="default" className="text-[10px]">
                <CheckCircle className="mr-1 size-2.5" />
                Active
              </Badge>
            )}
          </div>

          <QualityBar score={profile.qualityScore} />

          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <span>Created {new Date(profile.createdAt).toLocaleDateString()}</span>
            <span>ID: {profile.id.slice(0, 8)}...</span>
          </div>
        </div>

        <DropdownMenu>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7 shrink-0" disabled={isPending}>
                    {isPending ? <Loader2 className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-3.5" />}
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="left">Actions</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <DropdownMenuContent align="end">
            {profile.isActive ? (
              <DropdownMenuItem onClick={handleDeactivate}>
                <XCircle className="mr-2 size-3.5" />
                Deactivate
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={handleActivate}>
                <CheckCircle className="mr-2 size-3.5" />
                Activate
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive">
              <Trash2 className="mr-2 size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Profile List
// ---------------------------------------------------------------------------

function ProfileList() {
  const { data: profiles, isLoading, error } = useVoiceProfiles();

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Your Voice Profiles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="space-y-2 rounded-md border p-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-1.5 w-full" />
              <Skeleton className="h-3 w-48" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-6 text-center">
          <p className="text-sm text-destructive">Failed to load voice profiles</p>
          <p className="text-xs text-muted-foreground mt-1">
            {error instanceof Error ? error.message : 'Unknown error'}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!profiles?.length) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Fingerprint className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">No voice profiles yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Enroll your first voice profile to improve speaker diarization accuracy
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Your Voice Profiles</CardTitle>
          <Badge variant="outline" className="text-[10px]">
            {profiles.length} profile{profiles.length !== 1 && 's'}
          </Badge>
        </div>
        <CardDescription className="text-xs">
          The active profile is used for speaker identification in live transcription
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {profiles.map((p) => (
          <ProfileCard key={p.id} profile={p} />
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function VoiceProfilePage() {
  return (
    <PlaygroundLayout
      title="Voice Profile"
      description="Manage voice embeddings for speaker diarization"
      columns="two"
    >
      <EnrollCard />
      <ProfileList />
    </PlaygroundLayout>
  );
}
