'use client';

import { useState, type FormEvent } from 'react';
import { IconFileText, IconPlus, IconTrash, IconUpload } from '@tabler/icons-react';
import { toast } from 'sonner';
import { CodeEditor, validateJson } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { GatewayError } from '@/shared/api';
import { formatDateTime, formatNumber } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { DNA_INGEST_LIMITS, DNA_WRITING_SAMPLE_KINDS, useDnaIngestJobProgress, useIngestDnaWritingSamples } from '../api';
import type {
  DnaIngestWindow,
  DnaJobState,
  DnaWritingSample,
  DnaWritingSampleKind,
  IngestDnaWritingSamplesRequest,
  UseDnaIngestJobProgressResult,
} from '../api';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A stable id for a freshly-added draft row. */
function newSampleId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `sample-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** One row of the authoring form — the wire shape plus a stable row id and a raw `datetime-local` value. */
interface DraftSample {
  id: string;
  text: string;
  /** Raw `<input type="datetime-local">` value; converted to a full ISO-8601 UTC string at submit. */
  writtenAt: string;
  kind: DnaWritingSampleKind;
  sourceRef: string;
}

function blankSample(): DraftSample {
  return { id: newSampleId(), text: '', writtenAt: '', kind: 'OTHER', sourceRef: '' };
}

function isSampleKind(value: unknown): value is DnaWritingSampleKind {
  return typeof value === 'string' && (DNA_WRITING_SAMPLE_KINDS as readonly string[]).includes(value);
}

/** ISO-8601 UTC — always valid once `sampleIssues` has cleared the row (checked before submit is enabled). */
function toIso(writtenAt: string): string {
  return new Date(writtenAt).toISOString();
}

/** Same conversion, but tolerant of a blank/unparsable draft value (the advanced-JSON preview must never throw). */
function safeIso(writtenAt: string): string {
  const date = new Date(writtenAt);
  return Number.isNaN(date.getTime()) ? writtenAt : date.toISOString();
}

/** ISO -> the local `YYYY-MM-DDTHH:mm` shape `<input type="datetime-local">` expects (seconds are lost — acceptable on the advanced-JSON round trip only). */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toWireSample(sample: DraftSample): DnaWritingSample {
  const wire: DnaWritingSample = { text: sample.text, writtenAt: toIso(sample.writtenAt), kind: sample.kind };
  if (sample.sourceRef.trim()) wire.sourceRef = sample.sourceRef.trim();
  return wire;
}

/** Mirrors `IngestDnaWritingSamplesRequest.items`'s per-item bounds — checked before submit so a rejected batch is never a surprise after typing. */
function sampleIssues(sample: DraftSample): string[] {
  const issues: string[] = [];
  if (sample.text.trim().length === 0) issues.push('Add the writing sample text.');
  else if (sample.text.length > DNA_INGEST_LIMITS.maxItemChars) {
    issues.push(`Over the ${formatNumber(DNA_INGEST_LIMITS.maxItemChars)}-character limit.`);
  }
  if (sample.writtenAt.trim().length === 0) issues.push('Set when this was written.');
  else if (Number.isNaN(new Date(sample.writtenAt).getTime())) issues.push('Enter a valid date and time.');
  if (sample.sourceRef.length > 200) issues.push('Source ref is over 200 characters.');
  return issues;
}

/**
 * One authored writing sample: the wire fields plus a remove control. Deliberately a plain
 * repeatable row (rule 14/`_karpathy` §2 — no rich editor), mirroring `RuleRow` in
 * `dna-redaction-card.tsx` for the same reason: a list of small, labelled, removable field groups.
 */
function SampleRow({
  sample,
  index,
  disabled,
  showErrors,
  onChange,
  onRemove,
}: {
  sample: DraftSample;
  index: number;
  disabled: boolean;
  showErrors: boolean;
  onChange: (next: DraftSample) => void;
  onRemove: () => void;
}) {
  const rowLabel = `Sample ${index + 1}`;
  const issues = sampleIssues(sample);
  const invalid = showErrors && issues.length > 0;
  const textLength = sample.text.length;
  const textOverLimit = textLength > DNA_INGEST_LIMITS.maxItemChars;
  const errorId = `ingest-sample-error-${sample.id}`;

  return (
    <div className="border-border/60 flex flex-col gap-2 rounded-md border p-3" role="group" aria-label={rowLabel}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs font-medium">{rowLabel}</span>
        <Button type="button" variant="ghost" size="icon" onClick={onRemove} disabled={disabled} aria-label={`Remove ${rowLabel}`}>
          <IconTrash aria-hidden />
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`ingest-text-${sample.id}`}>
          Writing sample
          <span aria-hidden className="text-destructive">
            {' *'}
          </span>
        </Label>
        <Textarea
          id={`ingest-text-${sample.id}`}
          value={sample.text}
          onChange={(event) => onChange({ ...sample, text: event.target.value })}
          placeholder="Paste a case note, work note, or any prose the clinician authored…"
          rows={4}
          className="resize-none text-sm"
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
        />
        <p className={textOverLimit ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
          {formatNumber(textLength)} / {formatNumber(DNA_INGEST_LIMITS.maxItemChars)} characters
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-44 flex-col gap-1">
          <Label htmlFor={`ingest-written-at-${sample.id}`}>
            Written at
            <span aria-hidden className="text-destructive">
              {' *'}
            </span>
          </Label>
          <Input
            id={`ingest-written-at-${sample.id}`}
            type="datetime-local"
            value={sample.writtenAt}
            onChange={(event) => onChange({ ...sample, writtenAt: event.target.value })}
            disabled={disabled}
            aria-invalid={invalid || undefined}
          />
        </div>
        <div className="flex min-w-32 flex-col gap-1">
          <Label htmlFor={`ingest-kind-${sample.id}`}>Kind</Label>
          <Select value={sample.kind} onValueChange={(value) => onChange({ ...sample, kind: value as DnaWritingSampleKind })} disabled={disabled}>
            <SelectTrigger id={`ingest-kind-${sample.id}`} size="sm" aria-label={`${rowLabel} kind`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DNA_WRITING_SAMPLE_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {kind}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-40 flex-1 flex-col gap-1">
          <Label htmlFor={`ingest-source-ref-${sample.id}`}>Source ref (optional)</Label>
          <Input
            id={`ingest-source-ref-${sample.id}`}
            value={sample.sourceRef}
            onChange={(event) => onChange({ ...sample, sourceRef: event.target.value })}
            placeholder="e.g. an EMR note id"
            maxLength={200}
            disabled={disabled}
          />
        </div>
      </div>

      {invalid ? (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {issues.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

const INGEST_JOB_STATE_LABELS: Record<DnaJobState, string> = {
  queued: 'Queued',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

function ingestBadgeMeta(job: UseDnaIngestJobProgressResult['job'], isTerminal: boolean): { label: string; role: StatusColorRole } {
  if (isTerminal) return job?.status === 'completed' ? { label: 'Done', role: 'success' } : { label: 'Failed', role: 'destructive' };
  return { label: 'Polling', role: 'info' };
}

/**
 * Poll-only progress strip — mirrors `JobProgressStrip` in `generate-pane.tsx` (badge + bar +
 * percent, `aria-live="polite"`), but there is no SSE transport here to badge Live/Connecting: a
 * 2s poll is the ONLY mechanism on this route (README §4.1), never the error fallback.
 */
function IngestProgressStrip({ jobId, progress }: { jobId: string; progress: UseDnaIngestJobProgressResult }) {
  const { job, isTerminal } = progress;
  const percent = Math.max(0, Math.min(100, Math.round(job?.progress ?? 0)));
  const meta = ingestBadgeMeta(job, isTerminal);
  const stateLabel = job ? INGEST_JOB_STATE_LABELS[job.status] : 'Queued';

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />
        <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">{jobId}</span>
      </div>
      <Progress value={percent} aria-label={`DNA ingest analysis progress: ${stateLabel}, ${percent}%`} />
      <p aria-live="polite" className="text-muted-foreground text-xs tabular-nums">
        {stateLabel} {'·'} {percent}%
        {job?.status === 'failed' && job.error ? (
          <span className="text-destructive">
            {' '}
            {'·'} {job.error}
          </span>
        ) : null}
      </p>
    </div>
  );
}

/**
 * Frame 53 — the DNA writing-SAMPLE ingest pane (F-6): the spec's actual entry point ("a user
 * ingests their writing notes … to generate a DNA Writing Style report"), which had NO console
 * surface on any plane before this. `POST ingest` submits a TIME-ORDERED batch the platform has
 * not seen and queues the hidden `dna-writing-style-analyst` agent over it — a SEPARATE route
 * family from "Generate from my notes" above, which gathers from the caller's existing context
 * items instead.
 *
 * Gated exactly like the rest of the screen (`assertActingAsDoctor`) — EXCEPT the DTO also lets a
 * tenant/super admin name another clinician's `clinicianUserId`, which this pane exposes as one
 * optional field rather than a dedicated picker (out of scope for "a simple repeatable row").
 * Naming one is the one path that lets a non-clinical admin submit anyway, so the gate only
 * blocks the button when BOTH conditions hold: not acting as a doctor, and no clinician named.
 */
export function IngestPane({ gated, onGate }: { gated: boolean; onGate: () => void }) {
  const ingest = useIngestDnaWritingSamples();

  const [clinicianUserId, setClinicianUserId] = useState('');
  const [samples, setSamples] = useState<DraftSample[]>([]);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [rawJson, setRawJson] = useState('');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [lastAccepted, setLastAccepted] = useState<{ acceptedItems: number; window: DnaIngestWindow } | null>(null);

  const progress = useDnaIngestJobProgress(activeJobId, {
    onTerminal: (job) => {
      if (job.status === 'completed') {
        toast.success('DNA writing-style report regenerated from the ingested samples');
      } else {
        toast.error(job.error || 'DNA ingest analysis failed');
      }
    },
  });

  const totalChars = samples.reduce((sum, sample) => sum + sample.text.length, 0);
  const overCount = samples.length > DNA_INGEST_LIMITS.maxItems;
  const overTotalChars = totalChars > DNA_INGEST_LIMITS.maxTotalChars;
  const hasRowIssues = samples.some((sample) => sampleIssues(sample).length > 0);
  // A named clinician is the documented way a non-doctor admin may still call this route — the
  // gate blocks the button only when NEITHER condition that satisfies the gateway holds.
  const blockedByGate = gated && clinicianUserId.trim().length === 0;
  const canSubmit = !blockedByGate && !advanced && samples.length > 0 && !overCount && !overTotalChars && !hasRowIssues && !ingest.isPending;

  function addSample() {
    setSamples((current) => [...current, blankSample()]);
  }

  function updateSample(id: string, next: DraftSample) {
    setSamples((current) => current.map((sample) => (sample.id === id ? next : sample)));
  }

  function removeSample(id: string) {
    setSamples((current) => current.filter((sample) => sample.id !== id));
  }

  function enterAdvanced() {
    const items = samples.map((sample) => ({
      text: sample.text,
      writtenAt: safeIso(sample.writtenAt),
      kind: sample.kind,
      sourceRef: sample.sourceRef || undefined,
    }));
    const body: Record<string, unknown> = { items };
    if (clinicianUserId.trim()) body.clinicianUserId = clinicianUserId.trim();
    setRawJson(JSON.stringify(body, null, 2));
    setAdvanced(true);
  }

  function applyAdvanced() {
    const check = validateJson(rawJson);
    if (!check.ok) {
      toast.error(`Invalid JSON: ${check.message}`);
      return;
    }
    const parsed = JSON.parse(rawJson) as { clinicianUserId?: unknown; items?: unknown };
    if (!parsed || !Array.isArray(parsed.items)) {
      toast.error('Expected an object of shape { items: [...] }.');
      return;
    }
    setClinicianUserId(typeof parsed.clinicianUserId === 'string' ? parsed.clinicianUserId : '');
    setSamples(
      (parsed.items as Array<Record<string, unknown>>).map((item) => ({
        id: newSampleId(),
        text: typeof item.text === 'string' ? item.text : '',
        writtenAt: typeof item.writtenAt === 'string' ? toLocalInputValue(item.writtenAt) : '',
        kind: isSampleKind(item.kind) ? item.kind : 'OTHER',
        sourceRef: typeof item.sourceRef === 'string' ? item.sourceRef : '',
      })),
    );
    setAttemptedSubmit(false);
    setAdvanced(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      setAttemptedSubmit(true);
      return;
    }
    const body: IngestDnaWritingSamplesRequest = { items: samples.map(toWireSample) };
    if (clinicianUserId.trim()) body.clinicianUserId = clinicianUserId.trim();

    ingest.mutate(body, {
      onSuccess: (job) => {
        setLastAccepted({ acceptedItems: job.acceptedItems, window: job.window });
        setActiveJobId(job.jobId);
        setSamples([]);
        setAttemptedSubmit(false);
        toast.success(`Queued ${plural(job.acceptedItems, 'sample')} for analysis`);
      },
      onError: (error) => {
        if (error instanceof GatewayError && error.status === 403) {
          onGate();
          return;
        }
        toast.error(error instanceof GatewayError ? error.message : 'Could not queue the ingest job.');
      },
    });
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-medium">Ingest writing samples</h2>
        <CardAction>
          <span aria-hidden className="text-muted-foreground font-mono text-xs">
            POST /ingest
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">
          Submit case notes, work notes, or any prose you authored as a time-ordered batch — samples the platform has not seen. Unlike{' '}
          <span className="text-foreground font-medium">Generate from my notes</span> above, these do not need to already be context items; each
          sample carries its own written-at date, which orders the corpus and decides what survives if the batch is too large.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="playground-dna-ingest-clinician">Clinician user ID (optional)</Label>
            <Input
              id="playground-dna-ingest-clinician"
              value={clinicianUserId}
              onChange={(event) => setClinicianUserId(event.target.value)}
              placeholder="Leave blank to ingest your own samples"
              disabled={advanced || ingest.isPending}
            />
            <p className="text-muted-foreground text-xs">Naming another clinician requires a tenant or super admin — otherwise leave this blank.</p>
          </div>

          {advanced ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="playground-dna-ingest-json">Raw JSON</Label>
              <CodeEditor aria-label="Ingest request JSON" value={rawJson} onChange={setRawJson} language="json" className="min-h-64" />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setAdvanced(false)}>
                  Cancel
                </Button>
                <Button type="button" size="sm" onClick={applyAdvanced}>
                  Apply JSON
                </Button>
              </div>
            </div>
          ) : samples.length === 0 ? (
            <EmptyState
              icon={IconFileText}
              title="No samples added yet"
              description="Add a case note, work note, or any prose you authored — each with when it was written."
              action={
                <Button type="button" size="sm" onClick={addSample}>
                  <IconPlus aria-hidden />
                  Add sample
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
              <ul className="flex flex-col gap-3">
                {samples.map((sample, index) => (
                  <li key={sample.id}>
                    <SampleRow
                      sample={sample}
                      index={index}
                      disabled={ingest.isPending}
                      showErrors={attemptedSubmit}
                      onChange={(next) => updateSample(sample.id, next)}
                      onRemove={() => removeSample(sample.id)}
                    />
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={addSample}
                disabled={ingest.isPending || samples.length >= DNA_INGEST_LIMITS.maxItems}
              >
                <IconPlus aria-hidden />
                Add sample
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  label={`${formatNumber(samples.length)} / ${formatNumber(DNA_INGEST_LIMITS.maxItems)} samples`}
                  colorRole={overCount ? 'destructive' : 'neutral'}
                />
                <StatusBadge
                  label={`${formatNumber(totalChars)} / ${formatNumber(DNA_INGEST_LIMITS.maxTotalChars)} characters`}
                  colorRole={overTotalChars ? 'destructive' : 'neutral'}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            {blockedByGate ? (
              <span className="text-muted-foreground text-xs">Requires acting as a doctor, or naming a clinician above</span>
            ) : attemptedSubmit && samples.length === 0 ? (
              <span className="text-destructive text-xs">Add at least one sample before queuing.</span>
            ) : attemptedSubmit && !canSubmit && !advanced ? (
              <span className="text-destructive text-xs">Fix the highlighted issues before queuing.</span>
            ) : (
              <span />
            )}
            {!advanced ? (
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={enterAdvanced} disabled={ingest.isPending}>
                  Ingest as raw JSON
                </Button>
                <Button type="submit" size="sm" disabled={!canSubmit}>
                  {ingest.isPending ? <Spinner /> : <IconUpload aria-hidden />}
                  Queue ingest
                </Button>
              </div>
            ) : null}
          </div>
        </form>

        {lastAccepted ? (
          <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
            <p>
              Accepted <span className="font-medium">{plural(lastAccepted.acceptedItems, 'sample')}</span> spanning{' '}
              <time dateTime={lastAccepted.window.from}>{formatDateTime(lastAccepted.window.from, 'date')}</time>
              {' – '}
              <time dateTime={lastAccepted.window.to}>{formatDateTime(lastAccepted.window.to, 'date')}</time>.
            </p>
            {activeJobId ? <IngestProgressStrip jobId={activeJobId} progress={progress} /> : null}
          </div>
        ) : null}

        <p aria-hidden className="text-muted-foreground font-mono text-xs">
          Poll: GET /ingest/jobs/:jobId (no SSE on this route)
        </p>
      </CardContent>
    </Card>
  );
}
