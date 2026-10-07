'use client';

import { useId, useState } from 'react';
import { IconInfoCircle, IconPlus, IconRestore, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { GUARDRAIL_JUDGE_LANE_CATEGORIES, JUDGE_CONTROVERSIAL_TIER_VALUES, judgeMetadataProblems } from '@arcaai/types';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { useGuardrailJudgeMeta, useResetGuardrailJudgeMeta, useUpdateGuardrailJudgeMeta } from '../api/hooks';
import type { GuardrailJudgeCategoryTarget } from '../api/types';
import { ControlErrorState } from './control-states';
import { writeErrorMessage } from './guardrail-control-logic';
import { DefaultChangedNotice, SaveReScreenWarning } from './judge-prompt-editor';

export interface MappingDraft {
  categoryMap: Record<string, GuardrailJudgeCategoryTarget>;
  tiers: Record<string, string>;
}

const unsafeOf = (lane: string): string[] =>
  ((GUARDRAIL_JUDGE_LANE_CATEGORIES as Readonly<Record<string, readonly string[]>>)[lane] ?? []).filter((category) => category !== 'none');

/**
 * A `qwen3guard_native` judge (README §12.2): its own chat template is fixed and read-only; what the
 * platform admin owns is how its native categories and tiers MAP onto ours — `categoryMap` and the
 * Controversial tier. Validated live with the same `judgeMetadataProblems` the gateway applies.
 */
export function NativeMappingEditor({
  modelId,
  modelSlug,
  onDraftChange,
}: {
  modelId: string;
  modelSlug: string | null;
  /** The unsaved mapping when it differs from the stored one AND is valid, else `null` — the dry run sends it. */
  onDraftChange?: (draft: MappingDraft | null) => void;
}) {
  const uid = useId();
  const query = useGuardrailJudgeMeta(modelId);
  const update = useUpdateGuardrailJudgeMeta(modelId);
  const reset = useResetGuardrailJudgeMeta(modelId);
  const [draft, setDraft] = useState<MappingDraft | null>(null);
  const [newCategory, setNewCategory] = useState('');

  if (query.isError) return <ControlErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const meta = query.data;
  if (!meta) {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const saved: MappingDraft = { categoryMap: { ...(meta.judge.categoryMap ?? {}) }, tiers: { ...(meta.judge.tiers ?? {}) } };
  const current = draft ?? saved;
  const dirty = JSON.stringify(current) !== JSON.stringify(saved);
  const problems = judgeMetadataProblems({
    protocol: meta.judge.protocol,
    lanes: meta.judge.lanes,
    categoryMap: current.categoryMap,
    tiers: current.tiers,
  });
  const lanes = meta.judge.lanes;

  function change(next: MappingDraft | null) {
    setDraft(next);
    if (!onDraftChange) return;
    const candidate = next ?? saved;
    const valid = judgeMetadataProblems({ protocol: meta!.judge.protocol, lanes: meta!.judge.lanes, ...candidate }).length === 0;
    onDraftChange(JSON.stringify(candidate) !== JSON.stringify(saved) && valid ? candidate : null);
  }

  function setTarget(native: string, target: GuardrailJudgeCategoryTarget) {
    change({ ...current, categoryMap: { ...current.categoryMap, [native]: target } });
  }

  function remove(native: string) {
    const next = { ...current.categoryMap };
    delete next[native];
    change({ ...current, categoryMap: next });
  }

  function add() {
    const name = newCategory.trim();
    if (!name || current.categoryMap[name]) return;
    const lane = lanes[0] ?? '';
    setTarget(name, { lane, category: unsafeOf(lane)[0] ?? '' });
    setNewCategory('');
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <IconInfoCircle aria-hidden />
        <AlertTitle className="flex flex-wrap items-center gap-2">
          Native template
          <Badge variant="outline" className="font-mono text-xs">
            {modelSlug ?? meta.slug} · qwen3guard_native
          </Badge>
        </AlertTitle>
        <AlertDescription>
          This judge speaks its own fine-tuned chat template (read-only): no criteria prompt and no JSON response format are sent, and its Safety /
          Categories lines are parsed. Edit how its categories and tiers map onto the platform&apos;s lanes below.
        </AlertDescription>
      </Alert>

      <DefaultChangedNotice show={meta.defaultChangedSinceEdit} what="mapping" />

      <Table aria-label="Native category map">
        <TableHeader>
          <TableRow>
            <TableHead>Native category</TableHead>
            <TableHead>Lane</TableHead>
            <TableHead>Category</TableHead>
            <TableHead className="sr-only">Remove</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(current.categoryMap).map(([native, target], index) => (
            <TableRow key={native}>
              <TableCell className="font-mono text-xs">{native}</TableCell>
              <TableCell>
                <NativeSelect
                  aria-label={`Lane for ${native}`}
                  value={target.lane}
                  onChange={(event) => setTarget(native, { lane: event.target.value, category: unsafeOf(event.target.value)[0] ?? '' })}
                >
                  {lanes.map((lane) => (
                    <NativeSelectOption key={lane} value={lane}>
                      {lane}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </TableCell>
              <TableCell>
                <NativeSelect
                  aria-label={`Category for ${native}`}
                  value={target.category}
                  onChange={(event) => setTarget(native, { ...target, category: event.target.value })}
                >
                  {unsafeOf(target.lane).map((category) => (
                    <NativeSelectOption key={category} value={category}>
                      {category}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${native}`}
                  data-index={index}
                  onClick={() => remove(native)}
                >
                  <IconTrash aria-hidden />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-muted-foreground text-xs">An unmapped native category (PII, for example) is ignored and recorded as an info label.</p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-new`} className="text-xs">
            Map another native category
          </Label>
          <Input id={`${uid}-new`} value={newCategory} onChange={(event) => setNewCategory(event.target.value)} className="w-64" />
        </div>
        <Button type="button" variant="outline" size="sm" disabled={!newCategory.trim()} onClick={add}>
          <IconPlus aria-hidden />
          Add
        </Button>
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-medium">Verdict tiers</legend>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs">Safe</span>
          <Badge variant="outline">pass (fixed)</Badge>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-controversial`} className="text-xs">
            Controversial
          </Label>
          <NativeSelect
            id={`${uid}-controversial`}
            value={current.tiers.Controversial ?? 'warn'}
            onChange={(event) => change({ ...current, tiers: { ...current.tiers, Controversial: event.target.value } })}
          >
            {JUDGE_CONTROVERSIAL_TIER_VALUES.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs">Unsafe</span>
          <Badge variant="outline">flag (fixed — the check&apos;s action decides)</Badge>
        </div>
      </fieldset>

      <div aria-live="polite" id={`${uid}-problems`}>
        {problems.length > 0 ? (
          <ul className="text-destructive flex list-disc flex-col gap-1 pl-5 text-sm" aria-label="Mapping problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {dirty ? <SaveReScreenWarning /> : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={meta.isDefault || reset.isPending}
          onClick={() =>
            reset.mutate(undefined, {
              onSuccess: () => {
                toast.success('Mapping reset to default');
                change(null);
              },
              onError: (error) => toast.error(writeErrorMessage(error)),
            })
          }
        >
          <IconRestore aria-hidden />
          Reset to default
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={!dirty} onClick={() => change(null)}>
          Discard
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || problems.length > 0 || update.isPending}
          aria-describedby={problems.length > 0 ? `${uid}-problems` : undefined}
          onClick={() =>
            update.mutate(
              { body: { categoryMap: current.categoryMap, tiers: current.tiers }, version: meta.version },
              {
                onSuccess: () => {
                  toast.success('Mapping saved');
                  change(null);
                },
                onError: (error) => {
                  toast.error(writeErrorMessage(error));
                  change(null);
                },
              },
            )
          }
        >
          {update.isPending ? <Spinner /> : null}
          Save mapping
        </Button>
      </div>
    </div>
  );
}
