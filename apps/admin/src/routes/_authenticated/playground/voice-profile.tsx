import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useVoiceEmbedding } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, AudioWaveform, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { ConfirmDelete } from '@/features/common/confirm-delete';
import { EnrollVoiceDialog } from '@/features/playground/enroll-voice-dialog';
import { voiceProfileState } from '@/features/playground/playground-format';
import { formatDateTime } from '@/lib/utils';

export const Route = createFileRoute('/_authenticated/playground/voice-profile')({
  component: VoiceProfilePage,
});

/**
 * TASK-408 — screen 52 · Voice Profile (playground tier). Speaker-enrollment
 * lifecycle over the real `/voice-profile` API: enroll up to 3 audio samples,
 * activate one, deactivate or delete. An ACTIVE profile is the gate for
 * on-device diarization (the local STT provider refuses personalized
 * diarization without one). Self-scoped — every operation targets the
 * signed-in identity's own profiles.
 */
function VoiceProfilePage() {
  const voice = useVoiceEmbedding();
  const [enrollOpen, setEnrollOpen] = useState(false);

  useEffect(() => {
    void voice.list().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, []);

  const hasActive = voice.profiles.some((p) => p.isActive === true);

  const onEnroll = async (files: File[], label?: string) => {
    try {
      await voice.enroll(files, { label });
      toast.success('Voice samples enrolled.');
      void voice.list().catch(() => undefined);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Enrollment failed.');
      throw err;
    }
  };

  const run = async (action: Promise<void>, success: string) => {
    try {
      await action;
      toast.success(success);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Operation failed.');
    }
  };

  return (
    <div>
      <PageHeader
        title="Voice Profile"
        description="Speaker enrollment for on-device diarization — enroll audio samples of your own voice, then activate one profile. Self-scoped: you manage only your own profiles."
        actions={
          <Button size="sm" onClick={() => setEnrollOpen(true)} disabled={voice.isUploading}>
            <Plus className="size-4" />
            Enroll samples
          </Button>
        }
      />

      <Card className="mb-4 p-4" data-testid="enrollment-status-card">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge label={hasActive ? 'Enrollment active' : 'No active profile'} colorRole={hasActive ? 'success' : 'neutral'} />
          <span className="text-muted-foreground">
            {hasActive
              ? 'Personalized diarization is available to the capture pipeline for this identity.'
              : 'Without an active profile, the local STT provider declines personalized diarization (fail-closed).'}
          </span>
        </div>
      </Card>

      {voice.error && voice.profiles.length === 0 ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn’t load voice profiles</AlertTitle>
          <AlertDescription>{voice.error.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead className="max-md:hidden">Profile ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="max-lg:hidden">Model</TableHead>
              <TableHead className="max-md:hidden">Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {voice.isLoading && voice.profiles.length === 0 ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : voice.profiles.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <AudioWaveform className="size-8 text-muted-foreground" />
                    <p className="text-sm font-medium">No voice profiles yet</p>
                    <p className="text-xs text-muted-foreground">Enroll up to 3 audio samples to create your first speaker profile.</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              voice.profiles.map((p) => {
                const state = voiceProfileState(p);
                return (
                  <TableRow key={p.id} data-testid={`voice-profile-row-${p.id}`}>
                    <TableCell className="font-medium">{p.label || 'Untitled profile'}</TableCell>
                    <TableCell className="max-md:hidden">
                      <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge label={state.label} colorRole={state.colorRole} />
                    </TableCell>
                    <TableCell className="max-lg:hidden">
                      {p.modelId ? <span className="font-mono text-xs">{p.modelId}</span> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="tabular-nums max-md:hidden">{formatDateTime(p.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {p.isActive ? (
                          <Button variant="ghost" size="sm" className="h-8" onClick={() => void run(voice.deactivate(p.id), 'Profile deactivated.')}>
                            Deactivate
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" className="h-8" onClick={() => void run(voice.activate(p.id), 'Profile activated.')}>
                            Activate
                          </Button>
                        )}
                        <ConfirmDelete
                          trigger={
                            <Button variant="ghost" size="icon" className="size-8 text-destructive" aria-label={`Delete profile ${p.label || p.id}`}>
                              <Trash2 className="size-4" />
                            </Button>
                          }
                          title="Delete voice profile?"
                          description={
                            <>
                              “{p.label || p.id}” is removed permanently. If it was the active profile, personalized diarization stops until another
                              profile is activated.
                            </>
                          }
                          onConfirm={() => run(voice.delete(p.id), 'Profile deleted.')}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Sample audio is processed into an embedding server-side; the raw enrollment audio is not retrievable from here (no playback endpoint — flagged
        in TASK-408).
      </p>

      <EnrollVoiceDialog open={enrollOpen} onOpenChange={setEnrollOpen} onEnroll={onEnroll} />
    </div>
  );
}
