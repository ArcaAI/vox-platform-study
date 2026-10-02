'use client';

import { useId, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { GatewayError } from '@/shared/api';
import { formatNumber } from '@/shared/format';
import { useDnaIngestJobProgress, useDnaMemorySummary, useIngestDnaSamples } from '../api';
import type { DnaIngestItem, DnaIngestResponse } from '../api';
import { DNA_INGEST_LIMITS, parseIngestFile, validateIngestRows, type IngestRow } from '../lib/ingest-parse';
import { clinicianLabel } from './memory-tab';

const PREVIEW_CHARS = 120;

function toItem(row: IngestRow): DnaIngestItem {
  return {
    text: row.text,
    writtenAt: row.writtenAt,
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.sourceRef ? { sourceRef: row.sourceRef } : {}),
  };
}

function plural(count: number, word: string): string {
  return `${formatNumber(count)} ${word}${count === 1 ? '' : 's'}`;
}

/** Tenant-admin ingest of a clinician's historical writing (JSON / CSV / TXT). */
export function IngestTab() {
  const summary = useDnaMemorySummary();
  const ingest = useIngestDnaSamples();
  const pickerId = useId();
  const manualId = useId();
  const filesId = useId();
  const generateId = useId();

  const [picked, setPicked] = useState('');
  const [manual, setManual] = useState('');
  const [rows, setRows] = useState<IngestRow[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);
  const [generate, setGenerate] = useState(true);
  const [result, setResult] = useState<DnaIngestResponse | null>(null);

  const progress = useDnaIngestJobProgress(result?.jobId ?? null, {
    onTerminal: (job) => {
      if (job.status === 'completed') toast.success('DNA report generated from the ingested samples');
      else toast.error(job.error || 'DNA generation failed');
    },
  });

  const clinicianUserId = (manual.trim() || picked).trim();
  const validation = useMemo(() => validateIngestRows(rows), [rows]);
  const canSubmit = !!clinicianUserId && validation.valid && fileErrors.length === 0 && !parsing && !ingest.isPending;
  const blockedReason = !clinicianUserId
    ? 'Pick a clinician first.'
    : rows.length === 0
      ? 'Add at least one file.'
      : !validation.valid || fileErrors.length > 0
        ? 'Fix the errors listed above.'
        : null;

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setResult(null);
    if (files.length === 0) {
      setRows([]);
      setFileErrors([]);
      return;
    }
    setParsing(true);
    const parsed = await Promise.all(files.map((file) => parseIngestFile(file)));
    setRows(parsed.flatMap((file) => file.rows));
    setFileErrors(parsed.flatMap((file) => (file.error ? [file.error] : [])));
    setParsing(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    ingest.mutate(
      { clinicianUserId, generate, items: rows.map(toItem) },
      {
        onSuccess: (response) => {
          setResult(response);
          toast.success(`Ingested: ${plural(response.stored, 'sample')} stored, ${plural(response.duplicates, 'duplicate')}`);
        },
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not ingest the samples.'),
      },
    );
  }

  const job = progress.job;
  const percent = Math.max(0, Math.min(100, Math.round(job?.progress ?? (progress.isTerminal ? 100 : 0))));

  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit} noValidate>
      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium">Clinician and files</h2>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={pickerId}>Clinician *</Label>
            {summary.isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <NativeSelect id={pickerId} value={picked} onChange={(event) => setPicked(event.target.value)} className="w-full">
                <NativeSelectOption value="">Select a clinician</NativeSelectOption>
                {(summary.data ?? []).map((row) => (
                  <NativeSelectOption key={row.doctorId} value={row.doctorId}>
                    {clinicianLabel(row)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            <p className="text-muted-foreground text-xs">Lists clinicians that already have memory or a report.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={manualId}>Or user ID</Label>
            <Input
              id={manualId}
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              placeholder="Clinician user ID"
              className="font-mono"
            />
            <p className="text-muted-foreground text-xs">For a clinician with no memory yet; overrides the picker.</p>
          </div>
          <div className="flex flex-col gap-1.5 md:col-span-2">
            <Label htmlFor={filesId}>Files (.json, .csv, .txt) *</Label>
            <Input
              id={filesId}
              type="file"
              multiple
              accept=".json,.csv,.txt,application/json,text/csv,text/plain"
              onChange={(event) => void handleFiles(event)}
            />
            <p className="text-muted-foreground text-xs">
              JSON: an array of {'{ text, writtenAt, kind?, sourceRef? }'} or {'{ items: [...] }'}. CSV: header{' '}
              <span className="font-mono">text,writtenAt[,kind,sourceRef]</span>. TXT: each file is one note dated by its modified time. Limits:{' '}
              {DNA_INGEST_LIMITS.maxItems} samples, {formatNumber(DNA_INGEST_LIMITS.maxItemChars)} characters each,{' '}
              {formatNumber(DNA_INGEST_LIMITS.maxTotalChars)} in total.
            </p>
          </div>
          <div className="flex items-center gap-3 md:col-span-2">
            <Switch id={generateId} checked={generate} onCheckedChange={setGenerate} aria-label="Generate report now" />
            <Label htmlFor={generateId}>Generate report now</Label>
          </div>
        </CardContent>
      </Card>

      {fileErrors.length > 0 || validation.batchErrors.length > 0 ? (
        <ul className="text-destructive flex list-disc flex-col gap-1 pl-5 text-sm" role="alert">
          {[...fileErrors, ...(rows.length > 0 ? validation.batchErrors : [])].map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      {parsing ? (
        <Skeleton className="h-32 w-full" />
      ) : rows.length > 0 ? (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-medium">
              Preview {'·'} {plural(rows.length, 'sample')} {'·'} {formatNumber(validation.totalChars)} characters
            </h2>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Text</TableHead>
                  <TableHead>Written at</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => {
                  const errors = validation.rowErrors[index] ?? [];
                  return (
                    <TableRow key={`${row.source}-${index}`}>
                      <TableCell className="tabular-nums">{index + 1}</TableCell>
                      <TableCell className="max-w-md truncate" title={row.text.slice(0, 500)}>
                        {row.text.length > PREVIEW_CHARS ? `${row.text.slice(0, PREVIEW_CHARS)}…` : row.text}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.writtenAt}</TableCell>
                      <TableCell>{row.kind ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{row.sourceRef ?? row.source}</TableCell>
                      <TableCell>
                        {errors.length === 0 ? (
                          <Badge variant="secondary">OK</Badge>
                        ) : (
                          <span className="text-destructive text-sm">{errors.join(' ')}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!canSubmit}>
          {ingest.isPending ? <Spinner /> : null}
          Ingest {plural(rows.length, 'sample')}
        </Button>
        {blockedReason && !ingest.isPending ? <span className="text-muted-foreground text-sm">{blockedReason}</span> : null}
      </div>

      {result ? (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-medium">Result</h2>
          </CardHeader>
          <CardContent className="flex flex-col gap-3" aria-live="polite">
            <p className="text-sm">
              {formatNumber(result.stored)} stored {'·'} {plural(result.duplicates, 'duplicate')} skipped {'·'} clinician{' '}
              <span className="font-mono">{result.clinicianUserId}</span>
            </p>
            {result.jobId ? (
              <div className="flex flex-col gap-2">
                <Progress value={percent} aria-label={`Report generation: ${job?.status ?? 'queued'}, ${percent}%`} />
                <p className="text-muted-foreground text-xs">
                  Job <span className="font-mono">{result.jobId}</span> {'·'} {job?.status ?? 'queued'}
                  {job?.status === 'failed' && job.error ? (
                    <span className="text-destructive">
                      {' '}
                      {'·'} {job.error}
                    </span>
                  ) : null}
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">No report generation queued; the weekly job will consume these samples.</p>
            )}
          </CardContent>
        </Card>
      ) : null}
    </form>
  );
}
