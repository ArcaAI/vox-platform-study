import { Main } from '@/components/layout/main';
import { AdminDataTable } from '@/features/admin/components';
import { ImpersonationGuard } from '@/features/summarization/components/impersonation-guard';
import { useDoctorContext } from '@/features/summarization/hooks/use-doctor-context';
import { useAuthStore } from '@/store/auth-store';
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
import { Label } from '@arcaai/ui/label';
import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Building2,
  CheckCircle,
  FileAudio,
  Fingerprint,
  Loader2,
  Mic,
  MoreHorizontal,
  Square,
  Trash2,
  Upload,
  UserCheck,
  UserCog,
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
        <CardDescription className="text-xs">
          Record or upload audio samples to create a speaker embedding. At least one sample is required.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          onChange={handleFileChange}
          className="hidden"
          aria-label="Upload audio file for voice enrollment"
        />

        <div className="grid gap-8 md:grid-cols-2">
          {/* Left Column: Form & Actions */}
          <div className="space-y-6">
            <div className="space-y-3">
              <Label className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                1. Add Audio Samples
              </Label>

              {/* Recording indicator or action buttons */}
              {isRecording ? (
                <div className="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 sm:flex-row sm:items-center dark:border-red-900 dark:bg-red-950">
                  <div className="flex items-center gap-3">
                    <span className="relative flex size-3 shrink-0">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex size-3 rounded-full bg-red-500" />
                    </span>
                    <span className="text-sm font-medium text-red-700 dark:text-red-300">
                      Recording... {formatDuration(recordingElapsed)}
                    </span>
                  </div>
                  <div className="ml-auto flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
                    <span className="text-[10px] text-red-500">auto-stop at {MAX_SAMPLE_DURATION}s</span>
                    <Button variant="destructive" size="sm" onClick={stopRecording} className="w-full gap-1.5 sm:w-auto">
                      <Square className="size-3" />
                      Stop
                    </Button>
                  </div>
                </div>
              ) : !isFull ? (
                <div className="flex flex-col gap-2 sm:flex-row">
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
              ) : (
                <div className="text-muted-foreground rounded-lg border border-dashed bg-muted/10 px-4 py-3 text-center text-sm">
                  Maximum sample limit reached.
                </div>
              )}
            </div>

            <div className="space-y-3">
              <Label htmlFor="voice-profile-label" className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                2. Profile Information (Optional)
              </Label>
              <Input
                id="voice-profile-label"
                value={label}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
                disabled={isBusy}
                className="text-sm"
              />
            </div>

            <Button
              onClick={handleEnroll}
              disabled={!canEnroll || isBusy}
              className="w-full gap-2 sm:w-auto"
              size="default"
            >
              {enroll.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Extracting embedding...
                </>
              ) : (
                <>
                  <Fingerprint className="size-4" />
                  Enroll Voice Profile
                </>
              )}
            </Button>
          </div>

          {/* Right Column: Audio Sample Slots */}
          <div className="rounded-lg border bg-muted/20 p-4">
            <div className="mb-3 flex items-center justify-between">
              <Label className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                Audio Samples
              </Label>
              <span className="text-muted-foreground text-xs">
                {samples.length} / {MAX_SAMPLES} filled
              </span>
            </div>

            <div className="space-y-2">
              {Array.from({ length: MAX_SAMPLES }).map((_, i) => {
                const sample = samples[i];
                return sample ? (
                  <div key={sample.id} className="bg-background flex items-center justify-between rounded-md border px-3 py-2 shadow-sm transition-all hover:shadow-md">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <FileAudio className="text-primary size-4 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{sample.name}</p>
                        <p className="text-muted-foreground text-[10px]">Sample #{i + 1}</p>
                      </div>
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {formatDuration(sample.duration)}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive ml-2 size-7 shrink-0"
                      onClick={() => removeSample(sample.id)}
                      disabled={isBusy}
                    >
                      <XCircle className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <div
                    key={`empty-${i}`}
                    className="flex h-12 flex-col items-center justify-center rounded-md border border-dashed bg-muted/10 text-xs text-muted-foreground"
                  >
                    <span>Sample #{i + 1} — empty</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Profile Table
// ---------------------------------------------------------------------------

function ProfileTable() {
  const { data: profiles, isLoading, error } = useVoiceProfiles();
  const activate = useActivateVoiceProfile();
  const deactivate = useDeactivateVoiceProfile();
  const remove = useDeleteVoiceProfile();

  const isPending = activate.isPending || deactivate.isPending || remove.isPending;

  const handleActivate = (id: string) => {
    activate.mutate(id, {
      onSuccess: () => toast.success('Profile activated'),
      onError: (err) => toast.error(`Activate failed: ${err instanceof Error ? err.message : 'Unknown'}`),
    });
  };

  const handleDeactivate = (id: string) => {
    deactivate.mutate(id, {
      onSuccess: () => toast.success('Profile deactivated'),
      onError: (err) => toast.error(`Deactivate failed: ${err instanceof Error ? err.message : 'Unknown'}`),
    });
  };

  const handleDelete = (id: string) => {
    remove.mutate(id, {
      onSuccess: () => toast.success('Profile deleted'),
      onError: (err) => toast.error(`Delete failed: ${err instanceof Error ? err.message : 'Unknown'}`),
    });
  };

  const columns: ColumnDef<VoiceProfile, unknown>[] = [
    {
      accessorKey: 'label',
      header: 'Label',
      cell: ({ row }) => (
        <div>
          <span className="font-medium">{row.original.label || 'Unnamed'}</span>
          <p className="text-muted-foreground mt-0.5 text-xs">ID: {row.original.id}</p>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) =>
        row.original.isActive ? (
          <Badge variant="default" className="text-[10px]">
            <CheckCircle className="mr-1 size-2.5" />
            Active
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs">
            Inactive
          </Badge>
        ),
    },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">{new Date(row.original.createdAt).toLocaleDateString()}</span>
      ),
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      enableSorting: false,
      cell: ({ row }) => {
        const p = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" disabled={isPending}>
                {isPending ? <Loader2 className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-3.5" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {p.isActive ? (
                <DropdownMenuItem onClick={() => handleDeactivate(p.id)}>
                  <XCircle className="mr-2 size-3.5" />
                  Deactivate
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => handleActivate(p.id)}>
                  <CheckCircle className="mr-2 size-3.5" />
                  Activate
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleDelete(p.id)} className="text-destructive focus:text-destructive">
                <Trash2 className="mr-2 size-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">Your Voice Profiles</CardTitle>
            <CardDescription className="text-xs">
              The active profile is used for speaker identification in live transcription
            </CardDescription>
          </div>
          {(profiles?.length ?? 0) > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {profiles!.length} profile{profiles!.length !== 1 && 's'}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-md border py-8">
            <p className="text-destructive text-sm">Failed to load voice profiles</p>
            <p className="text-muted-foreground mt-1 text-xs">
              {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </div>
        ) : (
          <AdminDataTable
            data={profiles ?? []}
            columns={columns}
            isLoading={isLoading}
            emptyMessage="No voice profiles yet"
          />
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function VoiceProfilePage() {
  const tenantId = useAuthStore((s) => s.tenantId);
  const hasTenant = !!tenantId;
  const { requiresImpersonation, isImpersonated, roles } = useDoctorContext();

  const canAccess = hasTenant && !requiresImpersonation;

  return (
    <Main>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          {/* Header — always visible */}
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Voice Profile</h1>
              <p className="text-muted-foreground">Manage voice embeddings for speaker diarization.</p>
            </div>
            {canAccess && isImpersonated && (
              <Badge variant="secondary" className="gap-1.5">
                <UserCheck className="size-3" />
                Impersonating
              </Badge>
            )}
          </div>

          {/* Guard: no tenant */}
          {!hasTenant ? (
            <div>
              <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
                      <Building2 className="size-5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Tenant Required</CardTitle>
                      <CardDescription>Select a tenant to access voice profile features</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-muted-foreground text-sm">
                    Voice profiles are scoped to a specific tenant. Please select a tenant from the Playground Overview or impersonate a user that
                    belongs to a tenant.
                  </p>
                  <div className="flex items-center gap-3">
                    <Link to="/playground/overview">
                      <Button variant="default" size="sm" className="gap-2">
                        <UserCog className="size-4" />
                        Go to User Impersonation
                      </Button>
                    </Link>
                    <Badge variant="outline" className="text-xs">
                      Playground Overview &rarr; User Impersonation
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : /* Guard: impersonation required */
          requiresImpersonation ? (
            <ImpersonationGuard
              roles={roles}
              featureName="voice profile"
              featureDescription="Voice profiles are user-scoped and require impersonation to manage."
            />
          ) : (
            /* Content: full access */
            <div className="flex flex-col gap-6">
              <EnrollCard />
              <ProfileTable />
            </div>
          )}
        </div>
      </div>
    </Main>
  );
}
