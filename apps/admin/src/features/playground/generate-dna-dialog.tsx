import { Button } from '@arcaai/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Label } from '@arcaai/ui/label';
import { Textarea } from '@arcaai/ui/textarea';
import { useState } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';
import { splitTextSamples } from './playground-format';

/**
 * TASK-408 — DNA writing-style generation (screen 53). Collects writing
 * samples (split on blank lines) and hands them to the parent, which queues
 * the generation job (`useDnaStyle.generate`) and polls it — the dialog closes
 * as soon as the job is accepted so the page can show live job progress.
 */
export function GenerateDnaDialog({
  open,
  onOpenChange,
  onGenerate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGenerate: (textSamples: string[]) => Promise<void>;
}) {
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);

  const samples = splitTextSamples(raw);

  const handleOpenChange = (next: boolean) => {
    if (busy) return;
    if (!next) setRaw('');
    onOpenChange(next);
  };

  const submit = async () => {
    if (samples.length === 0) return;
    setBusy(true);
    try {
      await onGenerate(samples);
      setRaw('');
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={cn('flex h-[70vh] flex-col sm:max-w-[50vw]', MOBILE_DIALOG_CONTENT)}>
        <DialogHeader className="shrink-0">
          <DialogTitle>Generate DNA writing style</DialogTitle>
          <DialogDescription>
            Paste writing samples in your own words — clinical notes, letters, summaries. Separate samples with a blank line.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <Label htmlFor="dna-samples">
            Writing samples <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="dna-samples"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed"
            placeholder={'Patient presents with…\n\nFollow-up letter: Dear colleague…'}
          />
          <p className="shrink-0 text-xs text-muted-foreground">
            <span className="tabular-nums">{samples.length}</span> sample{samples.length === 1 ? '' : 's'} detected. Generation runs as a background
            job on the analysis service.
          </p>
        </div>
        <DialogFooter className={cn('shrink-0', MOBILE_DIALOG_FOOTER)}>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={samples.length === 0 || busy}>
            {busy ? 'Queueing…' : 'Generate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
