import { Button } from '@arcaai/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { AudioLines, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';

/** The `/voice-profile/enroll` endpoint accepts up to 3 audio samples per enrollment. */
export const MAX_ENROLL_FILES = 3;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * TASK-408 — voice-profile enrollment (screen 52). Collects up to
 * {@link MAX_ENROLL_FILES} audio samples + an optional label; the SDK
 * (`useVoiceEmbedding.enroll`) validates audio mime types and uploads
 * multipart. Parent owns the SDK call + toasts.
 */
export function EnrollVoiceDialog({
  open,
  onOpenChange,
  onEnroll,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnroll: (files: File[], label?: string) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setLabel('');
    setFiles([]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleOpenChange = (next: boolean) => {
    if (busy) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)].slice(0, MAX_ENROLL_FILES));
    if (inputRef.current) inputRef.current.value = '';
  };

  const submit = async () => {
    if (files.length === 0) return;
    setBusy(true);
    try {
      await onEnroll(files, label.trim() || undefined);
      reset();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={cn('sm:max-w-md', MOBILE_DIALOG_CONTENT)}>
        <DialogHeader>
          <DialogTitle>Enroll voice samples</DialogTitle>
          <DialogDescription>
            Upload up to {MAX_ENROLL_FILES} audio samples of the speaker. The profile powers on-device diarization once activated.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="voice-label">Label (optional)</Label>
            <Input id="voice-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Clinic headset" maxLength={100} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="voice-files">
              Audio samples <span className="text-destructive">*</span>
            </Label>
            <Input
              id="voice-files"
              ref={inputRef}
              type="file"
              accept="audio/*"
              multiple
              disabled={files.length >= MAX_ENROLL_FILES}
              onChange={(e) => addFiles(e.target.files)}
            />
            {files.length > 0 ? (
              <ul className="grid gap-1">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs">
                    <span className="flex min-w-0 items-center gap-2">
                      <AudioLines className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{f.name}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{formatSize(f.size)}</span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No samples selected yet.</p>
            )}
          </div>
        </div>
        <DialogFooter className={MOBILE_DIALOG_FOOTER}>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={files.length === 0 || busy}>
            {busy ? 'Enrolling…' : 'Enroll'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
