'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { IconAlertTriangle, IconExternalLink, IconPlayerPlay, IconPlus, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { GUARDRAIL_JUDGE_LANES } from '@arcaai/types';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { useGuardrailDryRun } from '../api/hooks';
import type { GuardrailDirection, GuardrailDryRunRequest } from '../api/types';
import { modelNotResident, writeErrorMessage } from './guardrail-control-logic';

const VERDICT_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  pass: 'secondary',
  flag: 'destructive',
  undetermined: 'outline',
};

/**
 * Dry run (README §11.3 B, OD-35): DRAFT prompts and mappings on sample text against the LIVE judge.
 * Persists nothing and never loads a model — a non-resident judge is a 409 that names the models and
 * links to Model residency; this panel offers no load action of its own.
 */
export function DryRunPanel({
  defaultLanes,
  draftPolicy,
  draftJudgeMeta,
}: {
  defaultLanes: string[];
  draftPolicy: Record<string, unknown>;
  draftJudgeMeta?: GuardrailDryRunRequest['judgeMeta'];
}) {
  const uid = useId();
  const dryRun = useGuardrailDryRun();
  const [lanes, setLanes] = useState<string[]>(defaultLanes);
  const [direction, setDirection] = useState<GuardrailDirection>('inbound');
  const [mode, setMode] = useState<'prompt' | 'response'>('prompt');
  const [samples, setSamples] = useState<string[]>(['']);

  const filled = samples.map((sample) => sample.trim()).filter(Boolean);
  const draftKeys = Object.keys(draftPolicy);
  const notResident = modelNotResident(dryRun.error);

  function run() {
    dryRun.mutate(
      {
        lanes,
        direction,
        mode,
        samples: filled,
        ...(draftKeys.length > 0 ? { policy: draftPolicy } : {}),
        ...(draftJudgeMeta ? { judgeMeta: draftJudgeMeta } : {}),
      },
      {
        onError: (error) => {
          if (!modelNotResident(error)) toast.error(writeErrorMessage(error));
        },
      },
    );
  }

  return (
    <section aria-labelledby={`${uid}-title`} className="flex flex-col gap-4 rounded-md border p-4">
      <div>
        <h2 id={`${uid}-title`} className="text-sm font-medium">
          Dry run
        </h2>
        <p className="text-muted-foreground text-xs">
          Runs on the live judge, stores nothing. {draftKeys.length > 0 ? `Includes your unsaved draft of ${draftKeys.join(', ')}.` : null}
          {draftJudgeMeta ? 'Includes your unsaved native mapping.' : null}
          {draftKeys.length === 0 && !draftJudgeMeta ? 'Uses the saved configuration.' : null}
        </p>
      </div>

      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-2 text-xs font-medium">Lanes</legend>
        {GUARDRAIL_JUDGE_LANES.map((lane) => (
          <div key={lane} className="flex items-center gap-2">
            <Checkbox
              id={`${uid}-${lane}`}
              checked={lanes.includes(lane)}
              onCheckedChange={(checked) => setLanes(checked === true ? [...lanes, lane] : lanes.filter((value) => value !== lane))}
            />
            <Label htmlFor={`${uid}-${lane}`} className="font-mono text-xs">
              {lane}
            </Label>
          </div>
        ))}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-direction`} className="text-xs">
            Direction
          </Label>
          <NativeSelect id={`${uid}-direction`} value={direction} onChange={(event) => setDirection(event.target.value as GuardrailDirection)}>
            <NativeSelectOption value="inbound">inbound</NativeSelectOption>
            <NativeSelectOption value="outbound">outbound</NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-mode`} className="text-xs">
            Native judge mode
          </Label>
          <NativeSelect id={`${uid}-mode`} value={mode} onChange={(event) => setMode(event.target.value as 'prompt' | 'response')}>
            <NativeSelectOption value="prompt">prompt moderation</NativeSelectOption>
            <NativeSelectOption value="response">response moderation</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {samples.map((sample, index) => (
          <div key={index} className="flex items-start gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor={`${uid}-sample-${index}`} className="text-xs">
                Sample {index + 1}
              </Label>
              <Textarea
                id={`${uid}-sample-${index}`}
                value={sample}
                rows={3}
                onChange={(event) => setSamples(samples.map((value, i) => (i === index ? event.target.value : value)))}
              />
            </div>
            {samples.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="mt-6"
                aria-label={`Remove sample ${index + 1}`}
                onClick={() => setSamples(samples.filter((_, i) => i !== index))}
              >
                <IconTrash aria-hidden />
              </Button>
            ) : null}
          </div>
        ))}
        <p className="text-muted-foreground text-xs">Synthetic text only — never paste real patient data.</p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={samples.length >= 50} onClick={() => setSamples([...samples, ''])}>
          <IconPlus aria-hidden />
          Add sample
        </Button>
        <Button type="button" size="sm" disabled={lanes.length === 0 || filled.length === 0 || dryRun.isPending} onClick={run}>
          {dryRun.isPending ? <Spinner /> : <IconPlayerPlay aria-hidden />}
          Run
        </Button>
      </div>

      {notResident ? (
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden />
          <AlertTitle>Judge model not resident</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{notResident.message ?? 'A judge model for a requested lane is not loaded.'} A dry run never loads a model.</span>
            <ul className="list-disc pl-5">
              {(notResident.models ?? []).map((model) => (
                <li key={`${model.lane}-${model.modelId}`}>
                  <span className="font-mono">{model.slug ?? model.modelId ?? 'no model'}</span> for {model.lane} — {model.state}
                </li>
              ))}
            </ul>
            <Link href={notResident.link ?? '/model-residency'} className="inline-flex items-center gap-1 underline underline-offset-4">
              Open Model residency
              <IconExternalLink aria-hidden className="size-3.5" />
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      {dryRun.data ? (
        <Table aria-label="Dry-run verdicts">
          <TableHeader>
            <TableRow>
              <TableHead>Sample</TableHead>
              <TableHead>Lane</TableHead>
              <TableHead>Verdict</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Confidence / tier</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Latency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {dryRun.data.results.flatMap((result) =>
              result.verdicts.map((verdict) => (
                <TableRow key={`${result.sampleIndex}-${verdict.lane}`}>
                  <TableCell>{result.sampleIndex + 1}</TableCell>
                  <TableCell className="font-mono text-xs">{verdict.lane}</TableCell>
                  <TableCell>
                    <Badge variant={VERDICT_VARIANT[verdict.verdict] ?? 'outline'}>{verdict.verdict}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{verdict.category ?? '—'}</TableCell>
                  <TableCell>{verdict.tier ?? (verdict.confidence === null ? '—' : verdict.confidence.toFixed(2))}</TableCell>
                  <TableCell className="font-mono text-xs">{verdict.model ?? '—'}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {verdict.latencyMs === null ? '—' : `${Math.round(verdict.latencyMs)} ms`}
                  </TableCell>
                </TableRow>
              )),
            )}
          </TableBody>
        </Table>
      ) : null}
    </section>
  );
}
