'use client';

import { useId, useRef, useState, type Ref } from 'react';
import { IconCheck, IconMicrophone, IconPlayerStopFilled, IconUpload, IconX } from '@tabler/icons-react';
import { toast } from 'sonner';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { formatBytes } from '@/shared/format';
import { MAX_LABEL_LENGTH, MAX_SAMPLES, MAX_SAMPLE_BYTES, useEnrollVoiceProfile } from '../api';
import { useSampleRecorder } from './use-sample-recorder';

type SampleSource = 'recorded' | 'uploaded';

interface StagedSample {
  id: number;
  file: File;
  source: SampleSource;
  /** Client-side pre-validation mirroring the gateway's ParseFilePipe. */
  error: string | null;
}

let sampleSequence = 0;

/** Mirrors the gateway validators: `audio/*` mime and the 10 MB per-file cap. */
function validateSample(file: File): string | null {
  if (!file.type.startsWith('audio/')) return 'Not an audio file \u2014 this plane accepts audio/* only.';
  if (file.size > MAX_SAMPLE_BYTES) return 'Over the 10 MB per-sample limit \u2014 trim or re-encode this sample.';
  return null;
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/**
 * Template slot row ("Sample 1/2/3"): staged files fill the three fixed slots
 * in index order — a filled slot shows a success check + the sample's
 * name/size (and its remove button); an empty slot shows a muted numbered
 * circle + "not recorded".
 */
function SampleSlotRow({
  index,
  sample,
  onRemove,
  disabled,
}: {
  index: number;
  sample: StagedSample | undefined;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <li className="flex flex-col gap-1 rounded-md border p-3">
      <div className="flex items-center gap-2">
        {sample ? (
          <span aria-hidden className="bg-success/10 text-success-strong flex size-5 shrink-0 items-center justify-center rounded-full">
            <IconCheck className="size-3.5" />
          </span>
        ) : (
          <span
            aria-hidden
            className="bg-muted text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-full text-xs tabular-nums"
          >
            {index + 1}
          </span>
        )}
        <span className="shrink-0 text-sm font-medium">Sample {index + 1}</span>
        {sample ? (
          <>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{sample.file.name}</span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatBytes(sample.file.size)}</span>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${sample.file.name}`} onClick={onRemove} disabled={disabled}>
              <IconX aria-hidden />
            </Button>
          </>
        ) : (
          <span className="text-muted-foreground flex-1 text-xs">not recorded</span>
        )}
      </div>
      {sample?.error ? <p className="text-destructive text-sm">{sample.error}</p> : null}
    </li>
  );
}

/**
 * Frame 52 enrollment wizard: record (MediaRecorder) or upload — file picker
 * or drag-and-drop — up to 3 audio samples, optionally label the profile,
 * then POST the multipart enroll. Files are pre-validated client-side with
 * inline per-file errors; the staged list resets after a successful submit
 * and the list query refreshes via the mutation's invalidation. `ref` lets
 * the screen's "+ Enroll voice profile" CTA move focus here (tabIndex -1).
 */
export function EnrollmentCard({ ref }: { ref?: Ref<HTMLDivElement> }) {
  const enroll = useEnrollVoiceProfile();
  const [samples, setSamples] = useState<StagedSample[]>([]);
  const [label, setLabel] = useState('');
  const [limitError, setLimitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const labelId = useId();

  const addFiles = (incoming: File[], source: SampleSource): void => {
    if (incoming.length === 0) return;
    const accepted = incoming.slice(0, Math.max(0, MAX_SAMPLES - samples.length));
    setLimitError(accepted.length < incoming.length ? `At most ${MAX_SAMPLES} samples per enrollment \u2014 remove one to add another.` : null);
    if (accepted.length === 0) return;
    setSamples((previous) =>
      [...previous, ...accepted.map((file) => ({ id: (sampleSequence += 1), file, source, error: validateSample(file) }))].slice(0, MAX_SAMPLES),
    );
  };

  const recorder = useSampleRecorder((file) => addFiles([file], 'recorded'));

  const atCapacity = samples.length >= MAX_SAMPLES;
  const hasInvalidSample = samples.some((sample) => sample.error !== null);
  const canSubmit = samples.length > 0 && !hasInvalidSample && !enroll.isPending;

  function handleUploadChange(event: React.ChangeEvent<HTMLInputElement>): void {
    addFiles(Array.from(event.target.files ?? []), 'uploaded');
    event.target.value = '';
  }

  function submit(): void {
    if (!canSubmit) return;
    enroll.mutate(
      { files: samples.map((sample) => sample.file), label: label.trim() || undefined },
      {
        onSuccess: () => {
          toast.success('Voice profile enrolled');
          setSamples([]);
          setLabel('');
          setLimitError(null);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <Card ref={ref} tabIndex={-1} className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-semibold">Enroll a profile</h2>
        {/* The POST /voice-profile/enroll hint lives in the screen footer. */}
        {recorder.phase === 'recording' ? (
          <CardAction>
            <span role="status">
              <StatusBadge
                label={`REC SAMPLE ${formatClock(recorder.elapsedSeconds)}`}
                colorRole="destructive"
                icon={<StatusDot colorRole="destructive" pulse size="sm" />}
              />
            </span>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {recorder.phase === 'recording' ? (
            <Button type="button" variant="destructive" className="h-11" onClick={recorder.stop}>
              <IconPlayerStopFilled aria-hidden />
              Stop recording
            </Button>
          ) : (
            <Button
              type="button"
              className="h-11"
              onClick={() => void recorder.start()}
              disabled={atCapacity || recorder.phase === 'requesting' || enroll.isPending}
            >
              <IconMicrophone aria-hidden />
              {atCapacity ? 'Record sample' : `Record sample ${samples.length + 1}`}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => fileInputRef.current?.click()}
            disabled={atCapacity || enroll.isPending}
          >
            <IconUpload aria-hidden />
            Upload
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            multiple
            tabIndex={-1}
            className="sr-only"
            aria-label="Upload audio samples"
            onChange={handleUploadChange}
          />
        </div>
        {recorder.phase === 'requesting' ? (
          <p role="status" className="text-muted-foreground text-sm">
            Requesting microphone permission{'\u2026'}
          </p>
        ) : null}
        {recorder.phase === 'denied' ? (
          <p className="text-destructive text-sm">
            Microphone access was denied {'\u2014'} allow the mic in your browser settings, or upload audio files instead.
          </p>
        ) : null}
        {recorder.phase === 'unsupported' ? (
          <p className="text-destructive text-sm">Recording is not supported in this browser {'\u2014'} upload audio files instead.</p>
        ) : null}
        {limitError ? <p className="text-destructive text-sm">{limitError}</p> : null}
        {/* Drop zone — drag-and-drop alternative to the picker (2.5.7: the picker IS the single-pointer path). */}
        <div
          className="rounded-md border border-dashed p-3"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (atCapacity || enroll.isPending) return;
            addFiles(Array.from(event.dataTransfer?.files ?? []), 'uploaded');
          }}
        >
          <ul aria-label="Samples" className="flex flex-col gap-2">
            {Array.from({ length: MAX_SAMPLES }, (_, index) => {
              const sample = samples[index];
              return (
                <SampleSlotRow
                  key={index}
                  index={index}
                  sample={sample}
                  disabled={enroll.isPending}
                  onRemove={() => {
                    if (sample) setSamples((previous) => previous.filter((row) => row.id !== sample.id));
                  }}
                />
              );
            })}
          </ul>
          <p className="text-muted-foreground pt-2 text-center text-xs">Drag and drop audio files here, or use Record / Upload.</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={labelId}>Profile name</Label>
          <Input
            id={labelId}
            value={label}
            maxLength={MAX_LABEL_LENGTH}
            placeholder="e.g. Clinic desk mic"
            autoComplete="off"
            disabled={enroll.isPending}
            onChange={(event) => setLabel(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Optional {'\u2014'} shown in the profile list, up to {MAX_LABEL_LENGTH} characters.
          </p>
        </div>
        {/* Segmented enrollment progress: one h-1.5 segment per sample slot, filled = staged. */}
        <div aria-hidden className="flex gap-1">
          {Array.from({ length: MAX_SAMPLES }, (_, index) => (
            <span key={index} className={index < samples.length ? 'bg-primary h-1.5 flex-1 rounded' : 'bg-muted h-1.5 flex-1 rounded'} />
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">
            {samples.length} of {MAX_SAMPLES} samples staged
            {samples.length === 0 ? ' \u2014 add at least one sample to enroll' : ''}
            {hasInvalidSample ? ' \u2014 remove the invalid samples to enroll' : ''}
          </p>
          <Button type="button" onClick={submit} disabled={!canSubmit}>
            {enroll.isPending ? <Spinner /> : null}
            Enroll profile
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          The browser asks for microphone permission on the first record. Samples: {'\u2264'}
          {MAX_SAMPLES} files, {'\u2264'}10 MB each, audio/* only.
        </p>
      </CardContent>
    </Card>
  );
}
