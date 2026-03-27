import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Button } from '@arcaai/ui/button';
import { Badge } from '@arcaai/ui/badge';
import { Skeleton } from '@arcaai/ui/skeleton';
import { useVoiceEmbedding } from '@arcaai/vox';
import { useAuthStore } from '@/store/auth-store';
import { AudioWaveform, Upload, Trash2, RefreshCw } from 'lucide-react';
import { useState, useRef } from 'react';
import { toast } from 'sonner';

const MAX_SAMPLES = 3;

export function VoiceEmbeddingPanel() {
  const { user } = useAuthStore();
  const userId = user?.id || 'current-user';
  const { status, isLoading, isUploading, upload, getStatus, remove } = useVoiceEmbedding();
  const [samples, setSamples] = useState<File[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (samples.length >= MAX_SAMPLES) {
      toast.error(`Maximum ${MAX_SAMPLES} samples allowed`);
      return;
    }
    setSamples((prev) => [...prev, file]);
  };

  const handleUpload = async (file: File) => {
    try {
      await upload(userId, file);
      toast.success('Voice sample uploaded');
      getStatus(userId);
    } catch {
      toast.error('Failed to upload voice sample');
    }
  };

  const handleRemove = async () => {
    try {
      await remove(userId);
      setSamples([]);
      toast.success('Voice embedding removed');
    } catch {
      toast.error('Failed to remove voice embedding');
    }
  };

  const removeSample = (index: number) => {
    setSamples((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AudioWaveform className="size-5" />
            <CardTitle>Voice Samples</CardTitle>
          </div>
          <CardDescription>Upload up to {MAX_SAMPLES} voice samples for speaker recognition</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <input ref={inputRef} type="file" accept="audio/*" onChange={handleFileSelect} className="hidden" />

          {samples.map((file, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
              <AudioWaveform className="text-muted-foreground size-4" />
              <span className="flex-1 truncate text-sm">{file.name}</span>
              <Button variant="outline" size="sm" onClick={() => handleUpload(file)} disabled={isUploading}>
                <Upload className="mr-1 size-3.5" />
                Upload
              </Button>
              <Button variant="ghost" size="sm" onClick={() => removeSample(i)}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}

          {samples.length < MAX_SAMPLES && (
            <Button variant="outline" className="w-full" onClick={() => inputRef.current?.click()}>
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
              <CardTitle>Embedding Status</CardTitle>
            </div>
            <Button variant="ghost" size="sm" onClick={() => getStatus(userId)}>
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
          <CardDescription>Current voice embedding state</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-48" />
            </div>
          ) : status ? (
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground text-sm">Status</span>
                <Badge variant={status.status === 'ready' ? 'default' : 'outline'}>{status.status}</Badge>
              </div>
              {status.samplesCount !== undefined && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground text-sm">Samples</span>
                  <span className="text-sm">{status.samplesCount}</span>
                </div>
              )}
              <Button variant="destructive" size="sm" className="w-full" onClick={handleRemove}>
                <Trash2 className="mr-1 size-3.5" />
                Remove Embedding
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No voice embedding found. Upload samples to create one.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
