import { useRef, useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, SttLanguageModePicker } from '@arcaai/ui';
import { PipelinePicker } from '../PipelinePicker';
import { usePlaygroundSession } from '../../context/playground-session';

/**
 * Batch-upload controls: pick the files, the pipeline they run through, the
 * language mode, and how many run at once.
 *
 * Drop-target + file input rather than input-only: a batch console is used by
 * dragging a folder's worth of clips in. The `<input type="file">` stays the
 * accessible path — it is the labelled control the keyboard and screen reader
 * use; the drop zone is an enhancement layered on the same handler, never the
 * only way in.
 *
 * The pipeline here is deliberately INDEPENDENT of the Connection tab's: the
 * common reason to open this tab is to run pre-recorded audio through a
 * different ASR pipeline than the live one. It is seeded from the connection
 * config so the default case needs no interaction.
 */
export function BatchUploadPanel() {
  const { batch, config, language } = usePlaygroundSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    batch.enqueue(Array.from(files));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Batch upload</CardTitle>
        <CardDescription>
          Pre-recorded audio through <code className="font-mono text-xs">useArcaBatchTranscription()</code> — one backend job per file, results
          streamed back over SSE. The v1 single-file <code className="font-mono text-xs">uploadAudioFile()</code> on{' '}
          <code className="font-mono text-xs">useArcaSpeechToText()</code> still works and hits the same endpoint.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="batch-files">Audio files</Label>
          <div
            data-testid="batch-dropzone"
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              addFiles(e.dataTransfer.files);
            }}
            className={`rounded-md border border-dashed p-4 text-center transition-colors ${isDragging ? 'border-primary bg-primary/5' : 'border-input'}`}
          >
            <Input
              ref={inputRef}
              id="batch-files"
              type="file"
              accept="audio/*"
              multiple
              onChange={(e) => {
                addFiles(e.target.files);
                // Reset so re-picking the SAME file fires `change` again.
                e.target.value = '';
              }}
            />
            <p className="text-muted-foreground mt-2 text-xs">…or drop files here. WAV/MP3/M4A/OGG/WEBM/FLAC, up to the gateway&apos;s size limit.</p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="batch-pipeline">Pipeline</Label>
          <PipelinePicker
            id="batch-pipeline"
            apiEndpoint={config.apiEndpoint}
            apiKey={config.apiKey}
            value={batch.pipelineId}
            onChange={batch.setPipelineId}
            placeholder="Pipeline id (uuid or slug)"
            aria-describedby="batch-pipeline-help"
          />
          <p id="batch-pipeline-help" className="text-muted-foreground text-xs">
            Applied to the NEXT enqueue. Files already in the queue keep the pipeline they were queued with.
          </p>
        </div>

        <SttLanguageModePicker label="STT language mode" modes={language.modes} value={language.mode} onValueChange={language.setMode} />

        <div className="flex flex-col gap-2">
          <Label htmlFor="batch-concurrency">Files in flight at once</Label>
          <Input
            id="batch-concurrency"
            type="number"
            min={1}
            max={8}
            value={batch.concurrency}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(next)) batch.setConcurrency(Math.min(8, Math.max(1, next)));
            }}
            aria-describedby="batch-concurrency-help"
            className="w-24"
          />
          <p id="batch-concurrency-help" className="text-muted-foreground text-xs">
            A slot is held for the whole lifecycle — upload AND result stream — so this also bounds how many SSE connections are open.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
            Choose files
          </Button>
          <Button variant="outline" size="sm" onClick={batch.clear} disabled={batch.items.length === 0}>
            Clear queue
          </Button>
          <span className="text-muted-foreground text-xs">
            {batch.items.length} queued · {batch.activeCount} active
          </span>
        </div>

        {batch.error ? <p className="text-destructive text-sm">{batch.error}</p> : null}
      </CardContent>
    </Card>
  );
}
