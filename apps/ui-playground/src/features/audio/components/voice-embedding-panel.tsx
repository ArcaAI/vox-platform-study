import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Button } from '@arcaai/ui/button';
import { Badge } from '@arcaai/ui/badge';
import { Skeleton } from '@arcaai/ui/skeleton';
import { useVoiceEmbedding } from '@arcaai/vox';
import { AudioWaveform, Fingerprint, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

const MAX_SAMPLES = 3;

interface QueuedSample {
  id: string;
  file: File;
}

/**
 * SDK reference panel for the new `useVoiceEmbedding` surface (TASK-265 D2).
 *
 * UX intent:
 * - User queues up to 3 audio samples via a hidden file input.
 * - User uploads a queued sample via `enroll(file)`.
 * - User sees their voice profiles via `list()` and deletes one via `delete(id)`.
 *
 * This panel is intentionally thin — it demonstrates how a consumer drives
 * the SDK hook directly (no TanStack Query layer). The fully-realised
 * voice-profile page lives at `features/voice-profile/index.tsx`.
 */
export function VoiceEmbeddingPanel() {
  const { profiles, isLoading, isUploading, enroll, list, delete: deleteProfile } = useVoiceEmbedding();
  const [samples, setSamples] = useState<QueuedSample[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void list();
  }, [list]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (samples.length >= MAX_SAMPLES) {
      toast.error(`Maximum ${MAX_SAMPLES} samples allowed`);
      return;
    }
    const id = (globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}-${samples.length}`) as string;
    setSamples((prev) => [...prev, { id, file }]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleUpload = async (sample: QueuedSample) => {
    try {
      await enroll(sample.file);
      toast.success('Voice sample uploaded');
      setSamples((prev) => prev.filter((s) => s.id !== sample.id));
      await list();
    } catch {
      toast.error('Failed to upload voice sample');
    }
  };

  const handleRemoveQueued = (id: string) => {
    setSamples((prev) => prev.filter((s) => s.id !== id));
  };

  const handleDeleteProfile = async (profileId: string) => {
    try {
      await deleteProfile(profileId);
      toast.success('Voice profile deleted');
      await list();
    } catch {
      toast.error('Failed to delete voice profile');
    }
  };

  const handleRefresh = async () => {
    try {
      await list();
    } catch {
      toast.error('Failed to refresh voice profiles');
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AudioWaveform className="size-5" />
            <CardTitle>Voice Samples</CardTitle>
          </div>
          <CardDescription>Upload up to {MAX_SAMPLES} voice samples to enroll a new voice profile</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <input ref={inputRef} type="file" accept="audio/*" onChange={handleFileSelect} className="hidden" aria-label="Add voice sample" />

          {samples.map((sample) => (
            <div key={sample.id} className="flex items-center gap-3 rounded-lg border p-3">
              <AudioWaveform className="text-muted-foreground size-4" />
              <span className="flex-1 truncate text-sm">{sample.file.name}</span>
              <Button variant="outline" size="sm" onClick={() => handleUpload(sample)} disabled={isUploading}>
                <Upload className="mr-1 size-3.5" />
                Upload
              </Button>
              <Button variant="ghost" size="sm" onClick={() => handleRemoveQueued(sample.id)} aria-label="Remove queued sample">
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}

          {samples.length < MAX_SAMPLES && (
            <Button variant="outline" className="w-full" onClick={() => inputRef.current?.click()} disabled={isUploading}>
              <Upload className="mr-2 size-4" />
              Add Voice Sample ({samples.length}/{MAX_SAMPLES})
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Fingerprint className="size-5" />
              <CardTitle>Your Voice Profiles</CardTitle>
            </div>
            <Button variant="ghost" size="sm" onClick={handleRefresh} aria-label="Refresh voice profiles">
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
          <CardDescription>Active voice profiles for speaker recognition</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading && profiles.length === 0 ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : profiles.length === 0 ? (
            <p className="text-muted-foreground text-sm">No voice profiles yet. Upload samples to create one.</p>
          ) : (
            profiles.map((profile) => {
              const label = typeof profile.label === 'string' && profile.label.length > 0 ? profile.label : `Profile ${profile.id}`;
              return (
                <div key={profile.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <Fingerprint className="text-muted-foreground size-4" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{label}</p>
                    <p className="text-muted-foreground text-xs">ID: {profile.id}</p>
                  </div>
                  <Badge variant={profile.isActive ? 'default' : 'outline'} className="text-[10px]">
                    {profile.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                  <Button variant="ghost" size="sm" onClick={() => handleDeleteProfile(profile.id)} aria-label={`Delete voice profile ${profile.id}`}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
