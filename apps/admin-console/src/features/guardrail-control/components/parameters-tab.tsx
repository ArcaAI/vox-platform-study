'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { IconAdjustments, IconExternalLink, IconRestore } from '@tabler/icons-react';
import { toast } from 'sonner';
import { CodeEditor } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { EmptyState } from '@/shared/state/empty-state';
import {
  useGuardrailHealth,
  useGuardrailJudgeLanes,
  useGuardrailModelSummary,
  useGuardrailPolicyKeys,
  useResetGuardrailPolicyKey,
  useUpdateGuardrailJudgeLanes,
  useUpdateGuardrailPolicyKey,
} from '../api/hooks';
import type { GuardrailJudgeLane, GuardrailJudgeLaneCandidate, GuardrailPolicyKeyEntry } from '../api/types';
import { ControlErrorState } from './control-states';
import { displayValue, writeErrorMessage } from './guardrail-control-logic';

const PARAMETER_KINDS = new Set(['hyperparameter', 'threshold', 'geometry']);

export function ResidencyBadge({ residency }: { residency: string }) {
  const variant = residency === 'loaded' ? 'secondary' : residency === 'not_loaded' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{residency.replaceAll('_', ' ')}</Badge>;
}

function boundsOf(entry: GuardrailPolicyKeyEntry): string {
  if (entry.min !== null && entry.max !== null) return `${entry.min} – ${entry.max}`;
  if (entry.min !== null) return `≥ ${entry.min}`;
  if (entry.max !== null) return `≤ ${entry.max}`;
  return 'unbounded';
}

function toText(entry: GuardrailPolicyKeyEntry, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (entry.type === 'object' || entry.type === 'string[]') return JSON.stringify(value, null, 2);
  return String(value);
}

/** Parse the field text for the key's declared type; `{ error }` blocks the save (the gateway re-checks). */
function parseField(entry: GuardrailPolicyKeyEntry, text: string): { value: unknown } | { error: string } {
  if (entry.type === 'number' || entry.type === 'integer') {
    if (text.trim() === '') return { error: 'A value is required.' };
    const value = Number(text);
    if (!Number.isFinite(value)) return { error: 'Must be a number.' };
    if (entry.type === 'integer' && !Number.isInteger(value)) return { error: 'Must be a whole number.' };
    if (entry.min !== null && value < entry.min) return { error: `Must be at least ${entry.min}.` };
    if (entry.max !== null && value > entry.max) return { error: `Must be at most ${entry.max}.` };
    return { value };
  }
  if (entry.type === 'boolean') return { value: text === 'true' };
  if (entry.type === 'object' || entry.type === 'string[]') {
    try {
      return { value: JSON.parse(text) as unknown };
    } catch {
      return { error: 'Must be valid JSON.' };
    }
  }
  return { value: text };
}

/** One bounded policy key: bounds and default shown, Reset per field, `If-Match` on the model row. */
function ParameterField({ entry }: { entry: GuardrailPolicyKeyEntry }) {
  const uid = useId();
  const update = useUpdateGuardrailPolicyKey();
  const reset = useResetGuardrailPolicyKey();
  const saved = toText(entry, entry.currentValue);
  const [text, setText] = useState<string | null>(null);
  const current = text ?? saved;
  const parsed = parseField(entry, current);
  const dirty = current !== saved;
  const error = 'error' in parsed ? parsed.error : null;

  function save() {
    if (!dirty || error || entry.modelVersion === null || !('value' in parsed)) return;
    update.mutate(
      { key: entry.key, value: parsed.value, modelVersion: entry.modelVersion },
      {
        onSuccess: () => {
          toast.success(`${entry.key} saved`);
          setText(null);
        },
        onError: (failure) => {
          toast.error(writeErrorMessage(failure));
          setText(null);
        },
      },
    );
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${uid}-value`} className="font-mono text-sm">
          {entry.key}
        </Label>
        <Badge variant="outline" className="text-xs">
          {entry.kind}
        </Badge>
        {entry.inPolicyVersion ? (
          <Badge variant="secondary" className="text-xs">
            re-screens on change
          </Badge>
        ) : null}
        {entry.isDefault ? null : <Badge className="text-xs">edited</Badge>}
      </div>
      {entry.type === 'boolean' ? (
        <Switch
          id={`${uid}-value`}
          checked={current === 'true'}
          onCheckedChange={(checked) => setText(String(checked))}
          aria-describedby={`${uid}-hint`}
        />
      ) : entry.type === 'object' || entry.type === 'string[]' ? (
        <CodeEditor aria-label={entry.key} value={current} onChange={setText} className="min-h-32" />
      ) : (
        <Input
          id={`${uid}-value`}
          type={entry.type === 'string' ? 'text' : 'number'}
          inputMode={entry.type === 'integer' ? 'numeric' : entry.type === 'number' ? 'decimal' : undefined}
          min={entry.min ?? undefined}
          max={entry.max ?? undefined}
          step={entry.type === 'integer' ? 1 : 'any'}
          value={current}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${uid}-hint`}
          className="max-w-48"
          onChange={(event) => setText(event.target.value)}
        />
      )}
      <p id={`${uid}-hint`} className="text-muted-foreground text-xs">
        Bounds {boundsOf(entry)} · default <span className="font-mono">{displayValue(entry.defaultValue)}</span> · on{' '}
        <span className="font-mono">{entry.modelSlug ?? entry.taskKey}</span>
      </p>
      {error && dirty ? <p className="text-destructive text-sm">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={entry.isDefault || reset.isPending}
          onClick={() =>
            reset.mutate(entry.key, {
              onSuccess: () => {
                toast.success(`${entry.key} reset to default`);
                setText(null);
              },
              onError: (failure) => toast.error(writeErrorMessage(failure)),
            })
          }
        >
          <IconRestore aria-hidden />
          Reset
        </Button>
        <Button type="button" size="sm" disabled={!dirty || Boolean(error) || entry.modelVersion === null || update.isPending} onClick={save}>
          {update.isPending ? <Spinner /> : null}
          Save
        </Button>
      </div>
    </li>
  );
}

function LaneSelector({ lane }: { lane: GuardrailJudgeLane }) {
  const uid = useId();
  const update = useUpdateGuardrailJudgeLanes();
  const [choice, setChoice] = useState<string | null>(null);
  const selectedId = choice ?? lane.selected?.modelId ?? '';
  const candidate: GuardrailJudgeLaneCandidate | undefined =
    lane.candidates.find((value) => value.modelId === selectedId) ?? lane.selected ?? undefined;
  const dirty = selectedId !== (lane.selected?.modelId ?? '');

  return (
    <TableRow>
      <TableCell>
        <Label htmlFor={`${uid}-lane`} className="font-mono text-xs">
          {lane.lane}
        </Label>
        <div className="text-muted-foreground font-mono text-[11px]">{lane.taskKey}</div>
      </TableCell>
      <TableCell>
        <NativeSelect
          id={`${uid}-lane`}
          value={selectedId}
          disabled={lane.candidates.length === 0}
          onChange={(event) => setChoice(event.target.value)}
          className="min-w-48"
        >
          {lane.selected ? null : <NativeSelectOption value="">— none elected —</NativeSelectOption>}
          {lane.candidates.map((value) => (
            <NativeSelectOption key={value.modelId} value={value.modelId}>
              {value.name ?? value.slug}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </TableCell>
      <TableCell className="font-mono text-xs">{candidate?.protocol ?? '—'}</TableCell>
      <TableCell className="font-mono text-xs">{candidate?.servedBy ?? '—'}</TableCell>
      <TableCell>{candidate ? <ResidencyBadge residency={candidate.residency} /> : '—'}</TableCell>
      <TableCell className="text-right">
        <Button
          type="button"
          size="sm"
          disabled={!dirty || !selectedId || update.isPending}
          onClick={() =>
            update.mutate([{ lane: lane.lane, modelId: selectedId }], {
              onSuccess: () => {
                toast.success(`${lane.lane} now judges on ${candidate?.slug ?? selectedId}`);
                setChoice(null);
              },
              onError: (failure) => toast.error(writeErrorMessage(failure)),
            })
          }
        >
          {update.isPending ? <Spinner /> : null}
          Apply
        </Button>
      </TableCell>
    </TableRow>
  );
}

const SERVING_LABELS: Record<string, string> = {
  contextLength: 'Context',
  parallel: 'Parallel',
  kvCacheQuant: 'KV quant',
  gpuSplit: 'GPU split',
  flashAttention: 'Flash attention',
  vramGiB: 'VRAM (GiB)',
  maxNumSeqs: 'Max seqs',
  enforceEager: 'Enforce eager',
};

/** Read-only: serving is edited in the model registry (OD-37). */
function ServingSummary({ candidate }: { candidate: GuardrailJudgeLaneCandidate }) {
  const query = useGuardrailModelSummary(candidate.modelId);
  const facts = query.data?.servingFacts ?? null;
  return (
    <Card className="gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm">{candidate.slug}</span>
        <ResidencyBadge residency={candidate.residency} />
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Protocol</dt>
        <dd className="font-mono">{candidate.protocol}</dd>
        <dt className="text-muted-foreground">Served by</dt>
        <dd className="font-mono">{candidate.servedBy ?? '—'}</dd>
        {query.isPending ? (
          <>
            <dt>
              <Skeleton className="h-3 w-16" />
            </dt>
            <dd>
              <Skeleton className="h-3 w-12" />
            </dd>
          </>
        ) : facts ? (
          Object.entries(facts).map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{SERVING_LABELS[key] ?? key}</dt>
              <dd className="font-mono">{displayValue(value)}</dd>
            </div>
          ))
        ) : (
          <>
            <dt className="text-muted-foreground">Serving facts</dt>
            <dd>none recorded</dd>
          </>
        )}
      </dl>
      <Link href="/ai-models" className="text-primary inline-flex items-center gap-1 text-xs underline underline-offset-4">
        Edit serving in AI models
        <IconExternalLink aria-hidden className="size-3" />
      </Link>
    </Card>
  );
}

function ParametersSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex flex-col gap-2 rounded-md border p-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-3 w-72" />
        </div>
      ))}
    </div>
  );
}

/** Parameters (README §11.3 D, §12.2): bounded keys, the judge model per lane, serving and residency read-only. */
export function ParametersTab() {
  const keys = useGuardrailPolicyKeys();
  const lanes = useGuardrailJudgeLanes();
  const health = useGuardrailHealth();

  const groups = (keys.data?.groups ?? [])
    .map((group) => ({ ...group, keys: group.keys.filter((key) => PARAMETER_KINDS.has(key.kind) && key.editable) }))
    .filter((group) => group.keys.length > 0);
  const judgeModels = new Map<string, GuardrailJudgeLaneCandidate>();
  for (const lane of lanes.data?.lanes ?? []) for (const candidate of lane.candidates) judgeModels.set(candidate.modelId, candidate);

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="params-keys" className="flex flex-col gap-3">
        <h2 id="params-keys" className="text-base font-medium">
          Hyper-parameters and thresholds
        </h2>
        {keys.isError ? (
          <ControlErrorState error={keys.error} onRetry={() => void keys.refetch()} />
        ) : !keys.data ? (
          <ParametersSkeleton />
        ) : groups.length === 0 ? (
          <EmptyState
            icon={IconAdjustments}
            title="No editable parameters"
            description="The catalogue declares no editable hyper-parameter, threshold or geometry key."
          />
        ) : (
          groups.map((group) => (
            <div key={group.taskKey} className="flex flex-col gap-2">
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span className="font-mono">{group.taskKey}</span>
                <Badge variant="outline">{group.modelSlug ?? 'no model elected'}</Badge>
                {group.protocol ? <Badge variant="secondary">{group.protocol}</Badge> : null}
              </h3>
              <ul className="grid gap-3 lg:grid-cols-2">
                {group.keys.map((entry) => (
                  <ParameterField key={`${entry.key}:${entry.modelVersion}`} entry={entry} />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <section aria-labelledby="params-lanes" className="flex flex-col gap-3">
        <div>
          <h2 id="params-lanes" className="text-base font-medium">
            Judge model per lane
          </h2>
          <p className="text-muted-foreground text-sm">
            Only models that declare a lane are offered. Switching a lane switches its parameters with it and re-screens.
          </p>
        </div>
        {lanes.isError ? (
          <ControlErrorState error={lanes.error} onRetry={() => void lanes.refetch()} />
        ) : !lanes.data ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <Table aria-label="Judge model per lane">
            <TableHeader>
              <TableRow>
                <TableHead>Lane</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead>Served by</TableHead>
                <TableHead>Residency</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Apply</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lanes.data.lanes.map((lane) => (
                <LaneSelector key={`${lane.lane}:${lane.policyId}`} lane={lane} />
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section aria-labelledby="params-serving" className="flex flex-col gap-3">
        <h2 id="params-serving" className="text-base font-medium">
          Judge serving
        </h2>
        {judgeModels.size === 0 ? (
          lanes.data ? (
            <p className="text-muted-foreground text-sm">No judge model is declared yet.</p>
          ) : (
            <Skeleton className="h-24 w-full" />
          )
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[...judgeModels.values()].map((candidate) => (
              <ServingSummary key={candidate.modelId} candidate={candidate} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="params-residency" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="params-residency" className="text-base font-medium">
            Residency
          </h2>
          <Link href="/model-residency" className="text-primary inline-flex items-center gap-1 text-sm underline underline-offset-4">
            Load or unload on Model residency
            <IconExternalLink aria-hidden className="size-3.5" />
          </Link>
        </div>
        {health.isError ? (
          <ControlErrorState error={health.error} onRetry={() => void health.refetch()} />
        ) : !health.data ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <ResidencyTable models={health.data.models} />
        )}
      </section>
    </div>
  );
}

export function ResidencyTable({ models }: { models: { taskKey: string; lane: string | null; slug: string | null; residency: string }[] }) {
  return (
    <Table aria-label="Guardrail model residency">
      <TableHeader>
        <TableRow>
          <TableHead>Task key</TableHead>
          <TableHead>Lane</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Residency</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((model) => (
          <TableRow key={model.taskKey}>
            <TableCell className="font-mono text-xs">{model.taskKey}</TableCell>
            <TableCell className="font-mono text-xs">{model.lane ?? '—'}</TableCell>
            <TableCell className="font-mono text-xs">{model.slug ?? '—'}</TableCell>
            <TableCell>
              <ResidencyBadge residency={model.residency} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
