'use client';

import { useId, useState } from 'react';
import { IconAlertTriangle, IconGitCompare, IconHistory, IconLock, IconRestore } from '@tabler/icons-react';
import { toast } from 'sonner';
import {
  GUARDRAIL_JUDGE_LOCKED_SECTIONS,
  GUARDRAIL_JUDGE_TEMPLATE_SECTIONS,
  GUARDRAIL_JUDGE_UNTRUSTED_DATA_CLAUSE,
  composeGuardrailJudgePrompt,
  guardrailJudgeOutputContract,
  validateGuardrailJudgePrompt,
  type GuardrailJudgePromptParts,
  type GuardrailJudgeTemplateSection,
} from '@arcaai/types';
import { CodeEditor, type JsonValidation } from '@arcaai/ui';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { useResetGuardrailPolicyKey, useResetGuardrailPolicyLane, useUpdateGuardrailPolicyKey } from '../api/hooks';
import type { GuardrailPolicyKeyEntry } from '../api/types';
import { lineDiff, parseJudgePromptParts, writeErrorMessage } from './guardrail-control-logic';
import { RevisionHistory } from './revision-history';

/** Prompt text is not JSON: the editor's JSON validity check is switched off (the template validator runs instead). */
const TEXT_OK = (): JsonValidation => ({ ok: true });

const SECTION_LABEL: Record<GuardrailJudgeTemplateSection, string> = {
  role_and_task: 'Role and task',
  unsafe_definitions: 'What counts as unsafe',
  safe_examples: 'What is safe',
  output_contract: 'Output contract',
  untrusted_data_clause: 'Untrusted-data clause',
};

const PART_OF: Partial<Record<GuardrailJudgeTemplateSection, keyof GuardrailJudgePromptParts>> = {
  role_and_task: 'roleAndTask',
  unsafe_definitions: 'unsafeDefinitions',
  safe_examples: 'safeExamples',
};

function scaffold(categories: readonly string[]): GuardrailJudgePromptParts {
  return {
    roleAndTask: '',
    unsafeDefinitions: categories
      .filter((category) => category !== 'none')
      .map((category) => `- ${category}: `)
      .join('\n'),
    safeExamples: '',
  };
}

export function SaveReScreenWarning() {
  return (
    <Alert>
      <IconAlertTriangle aria-hidden />
      <AlertTitle>Saving re-screens</AlertTitle>
      <AlertDescription>
        A prompt change changes the guardrail policy version: cached window verdicts are discarded and every window is screened again on its next
        request.
      </AlertDescription>
    </Alert>
  );
}

/** Diff of `before` → `after`, line by line. Meaning is carried by the +/− marker, not colour alone. */
export function DiffView({ before, after, label }: { before: string; after: string; label: string }) {
  const lines = lineDiff(before, after);
  return (
    <pre aria-label={label} className="bg-muted max-h-80 overflow-auto rounded-md p-3 font-mono text-xs">
      {lines.map((line, index) => (
        <div
          key={index}
          className={
            line.kind === 'add'
              ? 'bg-success/10 text-success-strong'
              : line.kind === 'del'
                ? 'bg-destructive/10 text-destructive-strong'
                : 'text-muted-foreground'
          }
        >
          {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '− ' : '  '}
          {line.text}
        </div>
      ))}
    </pre>
  );
}

/**
 * The criteria-prompt editor of one `criteria_json` safety-judge lane (README §11.3 C, OD-34): the five
 * template sections, the two locked ones read-only and greyed, validated live with the SAME
 * `validateGuardrailJudgePrompt` the gateway refuses a save with.
 */
export function JudgePromptEditor({
  entry,
  lane,
  categories,
  onDraftChange,
}: {
  entry: GuardrailPolicyKeyEntry;
  lane: string;
  categories: readonly string[];
  onDraftChange?: (key: string, value: string | null) => void;
}) {
  const uid = useId();
  const update = useUpdateGuardrailPolicyKey();
  const reset = useResetGuardrailPolicyKey();
  const resetLane = useResetGuardrailPolicyLane();
  const [parts, setParts] = useState<GuardrailJudgePromptParts | null>(null);
  const [panel, setPanel] = useState<'none' | 'diff' | 'history'>('none');

  const savedParts = parseJudgePromptParts(entry.currentValue);
  const defaultParts = parseJudgePromptParts(entry.defaultValue);
  const current = parts ?? savedParts;
  const readOnly = !entry.editable;

  function change(next: GuardrailJudgePromptParts) {
    setParts(next);
    const text = composeGuardrailJudgePrompt(next, categories);
    const valid = validateGuardrailJudgePrompt(text, categories).length === 0;
    onDraftChange?.(entry.key, text !== entry.currentValue && valid ? text : null);
  }

  if (!current) {
    return (
      <Alert>
        <IconAlertTriangle aria-hidden />
        <AlertTitle>This prompt does not follow the five-section template</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          <span>Start from the template to edit it here; the gateway refuses a save that is not in the template.</span>
          <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={() => change(defaultParts ?? scaffold(categories))}>
            Start from the {defaultParts ? 'default' : 'empty'} template
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const composed = composeGuardrailJudgePrompt(current, categories);
  const errors = validateGuardrailJudgePrompt(composed, categories);
  const dirty = composed !== entry.currentValue;
  const canSave = dirty && errors.length === 0 && entry.modelVersion !== null && !readOnly && !update.isPending;
  const locked: Record<string, string> = {
    output_contract: guardrailJudgeOutputContract(categories),
    untrusted_data_clause: GUARDRAIL_JUDGE_UNTRUSTED_DATA_CLAUSE,
  };

  function save() {
    if (!canSave) return;
    update.mutate(
      { key: entry.key, value: composed, modelVersion: entry.modelVersion as number },
      {
        onSuccess: (result) => {
          toast.success(result.changed === false ? 'No change: the prompt already read this way' : `${entry.key} saved`);
          onDraftChange?.(entry.key, null);
        },
        onError: (error) => toast.error(writeErrorMessage(error)),
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono">{entry.key}</span>
        <Badge variant="outline">{entry.modelSlug ?? 'no model elected'}</Badge>
        {entry.isDefault ? <Badge variant="secondary">default</Badge> : <Badge>edited</Badge>}
        {readOnly ? <Badge variant="outline">read-only</Badge> : null}
      </div>

      {GUARDRAIL_JUDGE_TEMPLATE_SECTIONS.map((section) => {
        const isLocked = (GUARDRAIL_JUDGE_LOCKED_SECTIONS as readonly string[]).includes(section);
        const field = PART_OF[section];
        return (
          <div key={section} className="flex flex-col gap-1.5" data-section={section} data-locked={isLocked || undefined}>
            <span className="flex items-center gap-2 text-sm font-medium">
              {SECTION_LABEL[section]}
              {isLocked ? (
                <Badge variant="outline" className="gap-1 text-xs">
                  <IconLock aria-hidden className="size-3" />
                  Locked
                </Badge>
              ) : null}
            </span>
            {isLocked ? (
              <CodeEditor
                aria-label={`${SECTION_LABEL[section]} (locked)`}
                value={locked[section] as string}
                readOnly
                showToolbar={false}
                validate={TEXT_OK}
                className="min-h-16 opacity-60"
              />
            ) : (
              <CodeEditor
                aria-label={SECTION_LABEL[section]}
                value={current[field as keyof GuardrailJudgePromptParts]}
                readOnly={readOnly}
                showToolbar={false}
                validate={TEXT_OK}
                onChange={(value) => change({ ...current, [field as keyof GuardrailJudgePromptParts]: value })}
                className={section === 'role_and_task' ? 'min-h-24' : 'min-h-40'}
              />
            )}
          </div>
        );
      })}

      <div aria-live="polite" id={`${uid}-errors`}>
        {errors.length > 0 ? (
          <ul className="text-destructive flex list-disc flex-col gap-1 pl-5 text-sm" aria-label="Template problems">
            {errors.map((error, index) => (
              <li key={index}>{error.message}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">The prompt follows the template for {lane}.</p>
        )}
      </div>

      {dirty ? <SaveReScreenWarning /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={panel === 'diff' ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={panel === 'diff'}
          onClick={() => setPanel(panel === 'diff' ? 'none' : 'diff')}
        >
          <IconGitCompare aria-hidden />
          Diff vs default
        </Button>
        <Button
          type="button"
          variant={panel === 'history' ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={panel === 'history'}
          onClick={() => setPanel(panel === 'history' ? 'none' : 'history')}
        >
          <IconHistory aria-hidden />
          History
        </Button>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={readOnly || resetLane.isPending}
          onClick={() =>
            resetLane.mutate(lane, {
              onSuccess: (result) =>
                toast.success(
                  result.resetKeys.length > 0 ? `Reset ${result.resetKeys.length} key(s) on ${result.taskKey}` : 'Every key already at its default',
                ),
              onError: (error) => toast.error(writeErrorMessage(error)),
            })
          }
        >
          Reset lane
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={readOnly || entry.isDefault || reset.isPending}
          onClick={() =>
            reset.mutate(entry.key, {
              onSuccess: () => toast.success(`${entry.key} reset to default`),
              onError: (error) => toast.error(writeErrorMessage(error)),
            })
          }
        >
          <IconRestore aria-hidden />
          Reset to default
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={!dirty || update.isPending} onClick={() => change(savedParts ?? current)}>
          Discard
        </Button>
        <Button type="button" size="sm" disabled={!canSave} aria-describedby={errors.length > 0 ? `${uid}-errors` : undefined} onClick={save}>
          {update.isPending ? <Spinner /> : null}
          Save prompt
        </Button>
      </div>

      {panel === 'diff' ? (
        typeof entry.defaultValue === 'string' ? (
          <DiffView before={entry.defaultValue} after={composed} label={`Diff of ${entry.key} against its default`} />
        ) : (
          <p className="text-muted-foreground text-sm">The seed ships no default for this key.</p>
        )
      ) : null}
      {panel === 'history' ? <RevisionHistory policyKey={entry.key} /> : null}
    </div>
  );
}

/** The medical-validation criteria keys follow their own verdict schema, not the five-section template. */
export function PlainCriteriaEditor({ entry }: { entry: GuardrailPolicyKeyEntry }) {
  const update = useUpdateGuardrailPolicyKey();
  const reset = useResetGuardrailPolicyKey();
  const [text, setText] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const saved = typeof entry.currentValue === 'string' ? entry.currentValue : '';
  const current = text ?? saved;
  const dirty = current !== saved;
  const empty = current.trim().length === 0;
  const readOnly = !entry.editable;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono">{entry.key}</span>
        {entry.isDefault ? <Badge variant="secondary">default</Badge> : <Badge>edited</Badge>}
      </div>
      <CodeEditor
        aria-label={entry.key}
        value={current}
        readOnly={readOnly}
        showToolbar={false}
        validate={TEXT_OK}
        onChange={setText}
        className="min-h-32"
      />
      {empty ? <p className="text-destructive text-sm">The criteria text must not be empty.</p> : null}
      {dirty ? <SaveReScreenWarning /> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>
          <IconHistory aria-hidden />
          History
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={readOnly || entry.isDefault || reset.isPending}
          onClick={() =>
            reset.mutate(entry.key, {
              onSuccess: () => toast.success(`${entry.key} reset to default`),
              onError: (error) => toast.error(writeErrorMessage(error)),
            })
          }
        >
          <IconRestore aria-hidden />
          Reset to default
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || empty || readOnly || entry.modelVersion === null || update.isPending}
          onClick={() =>
            update.mutate(
              { key: entry.key, value: current, modelVersion: entry.modelVersion as number },
              { onSuccess: () => toast.success(`${entry.key} saved`), onError: (error) => toast.error(writeErrorMessage(error)) },
            )
          }
        >
          {update.isPending ? <Spinner /> : null}
          Save
        </Button>
      </div>
      {showHistory ? <RevisionHistory policyKey={entry.key} /> : null}
    </div>
  );
}
