'use client';

/**
 * `ConditionBranchesField` — TASK-1036 §8.4 item 6, "Conditions without CEL".
 *
 * `core.condition.branches` is an array of `{ key, label?, when }`. Each path gets a visual rule
 * builder — a field from the SAME picker every other field uses (conditions read earlier steps,
 * the Input and variables; consultation and run fields are shown blocked with the reason), an
 * operator and a value — which GENERATES the CEL stored in `when` (`lib/condition-builder.ts`).
 * Raw CEL stays one click away ("Edit as expression"); an expression the builder cannot represent
 * opens in expression mode and is never rewritten behind the author's back.
 */
import { useId, useState } from 'react';
import { Button, Field, FieldDescription, FieldLabel, Input, NativeSelect, NativeSelectOption } from '@arcaai/ui';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import {
  CONDITION_OPERATORS,
  celPathOf,
  celToCondition,
  conditionToCel,
  type ConditionModel,
  type ConditionOperator,
  type ConditionRule,
} from '../../lib/condition-builder';
import type { PickerGroup } from '../../lib/picker-model';
import { CelExpressionField } from './cel-expression-field';
import { FieldPicker } from './field-picker';

export interface ConditionBranch {
  key: string;
  label?: string;
  when: string;
}

export interface ConditionBranchesFieldProps {
  idPrefix: string;
  branches: readonly ConditionBranch[];
  onChange: (branches: ConditionBranch[]) => void;
  /** The condition picker's groups (`purpose: 'condition'`). */
  groups: readonly PickerGroup[];
  disabled?: boolean;
  errors?: string[];
}

const KEY_PATTERN = /^[a-z0-9_]{2,48}$/;

function fieldLabel(field: string, groups: readonly PickerGroup[]): string {
  for (const group of groups) {
    for (const item of group.items) if (celPathOf(item.raw) === field) return item.path;
  }
  return field;
}

function nextKey(branches: readonly ConditionBranch[]): string {
  for (let index = branches.length + 1; ; index += 1) {
    const key = `path_${index}`;
    if (!branches.some((branch) => branch.key === key)) return key;
  }
}

function BranchEditor({
  branch,
  index,
  idPrefix,
  groups,
  disabled,
  onBranchChange,
  onRemove,
}: {
  branch: ConditionBranch;
  index: number;
  idPrefix: string;
  groups: readonly PickerGroup[];
  disabled?: boolean;
  onBranchChange: (next: ConditionBranch) => void;
  onRemove?: () => void;
}) {
  const uid = useId();
  const legendId = `${uid}-legend`;
  const parsed = celToCondition(branch.when);
  const [expressionMode, setExpressionMode] = useState(parsed === null);
  // The builder's own draft: a rule with no field yet cannot be written as CEL, so the draft keeps
  // it while the stored `when` holds only the complete rules. Re-synced when `when` changes from
  // outside (undo, another editor).
  const [draft, setDraft] = useState<ConditionModel>(parsed ?? { join: 'all', rules: [] });
  const [seenWhen, setSeenWhen] = useState(branch.when);
  if (branch.when !== seenWhen) {
    setSeenWhen(branch.when);
    if (conditionToCel(draft) !== branch.when) {
      const reparsed = celToCondition(branch.when);
      if (reparsed) setDraft(reparsed);
      else setExpressionMode(true);
    }
  }

  const commit = (model: ConditionModel) => {
    setDraft(model);
    const when = conditionToCel(model);
    setSeenWhen(when);
    onBranchChange({ ...branch, when });
  };
  const updateRule = (ruleIndex: number, patch: Partial<ConditionRule>) =>
    commit({ ...draft, rules: draft.rules.map((rule, position) => (position === ruleIndex ? { ...rule, ...patch } : rule)) });

  const keyInvalid = !KEY_PATTERN.test(branch.key);
  const rules = draft.rules.length > 0 ? draft.rules : [{ field: '', operator: 'eq' as ConditionOperator, value: '' }];

  return (
    <fieldset aria-labelledby={legendId} className="flex flex-col gap-2 rounded-md border p-2" disabled={disabled}>
      <legend id={legendId} className="sr-only">
        Path {branch.key}
      </legend>
      <div className="flex items-end gap-2">
        <Field className="flex-1" data-invalid={keyInvalid ? 'true' : undefined}>
          <FieldLabel htmlFor={`${uid}-key`}>Path name</FieldLabel>
          <Input id={`${uid}-key`} value={branch.key} className="h-8 font-mono" onChange={(event) => onBranchChange({ ...branch, key: event.target.value })} />
          {keyInvalid ? <p className="text-destructive text-sm">Use 2–48 lower-case letters, digits or underscores.</p> : null}
        </Field>
        {onRemove ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove path ${branch.key}`} onClick={onRemove}>
            <IconTrash aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {expressionMode ? (
        <div className="flex flex-col gap-1">
          {celToCondition(branch.when) === null ? <p className="text-muted-foreground text-xs">This condition is written as an expression.</p> : null}
          <CelExpressionField
            id={`${idPrefix}-branch-${index}-when`}
            label={`Condition for ${branch.key}`}
            value={branch.when}
            onChange={(when) => {
              setSeenWhen(when);
              onBranchChange({ ...branch, when });
            }}
            disabled={disabled}
          />
          {celToCondition(branch.when) !== null ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="self-start px-0"
              onClick={() => {
                setDraft(celToCondition(branch.when) ?? { join: 'all', rules: [] });
                setExpressionMode(false);
              }}
            >
              Back to the rule builder
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rules.length > 1 ? (
            <NativeSelect aria-label={`How the rules of ${branch.key} combine`} value={draft.join} onChange={(event) => commit({ ...draft, join: event.target.value as ConditionModel['join'] })}>
              <NativeSelectOption value="all">Take this path when ALL rules match</NativeSelectOption>
              <NativeSelectOption value="any">Take this path when ANY rule matches</NativeSelectOption>
            </NativeSelect>
          ) : (
            <p className="text-muted-foreground text-xs">Take this path when:</p>
          )}
          <ol className="flex flex-col gap-2">
            {rules.map((rule, ruleIndex) => {
              const operator = CONDITION_OPERATORS.find((candidate) => candidate.value === rule.operator);
              return (
                <li key={ruleIndex} className="flex flex-wrap items-center gap-1">
                  <FieldPicker
                    groups={groups}
                    disabled={disabled}
                    triggerClassName="max-w-[14rem] justify-start font-mono"
                    triggerLabel={
                      rule.field ? (
                        <span className="truncate">{fieldLabel(rule.field, groups)}</span>
                      ) : (
                        <span>
                          Choose a field<span className="sr-only"> for rule {ruleIndex + 1}</span>
                        </span>
                      )
                    }
                    onPick={(item) => {
                      const field = celPathOf(item.raw);
                      if (draft.rules.length === 0) commit({ ...draft, rules: [{ field, operator: 'eq', value: '' }] });
                      else updateRule(ruleIndex, { field });
                    }}
                  />
                  <NativeSelect
                    aria-label={`Operator for rule ${ruleIndex + 1}`}
                    value={rule.operator}
                    onChange={(event) => updateRule(ruleIndex, { operator: event.target.value as ConditionOperator })}
                    className="w-auto"
                  >
                    {CONDITION_OPERATORS.map((candidate) => (
                      <NativeSelectOption key={candidate.value} value={candidate.value}>
                        {candidate.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {operator?.needsValue !== false ? (
                    <Input aria-label={`Value for rule ${ruleIndex + 1}`} value={rule.value} className="h-8 w-32" onChange={(event) => updateRule(ruleIndex, { value: event.target.value })} />
                  ) : null}
                  {draft.rules.length > 1 ? (
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove rule ${ruleIndex + 1}`} onClick={() => commit({ ...draft, rules: draft.rules.filter((_, position) => position !== ruleIndex) })}>
                      <IconTrash aria-hidden="true" />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={draft.rules.length === 0} onClick={() => setDraft({ ...draft, rules: [...draft.rules, { field: '', operator: 'eq', value: '' }] })}>
              <IconPlus aria-hidden="true" />
              Add a rule
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setExpressionMode(true)}>
              Edit as expression
            </Button>
          </div>
        </div>
      )}
    </fieldset>
  );
}

export function ConditionBranchesField({ idPrefix, branches, onChange, groups, disabled, errors }: ConditionBranchesFieldProps) {
  return (
    <section aria-labelledby={`${idPrefix}-paths-heading`} className="flex flex-col gap-2" data-slot="condition-branches">
      <h3 id={`${idPrefix}-paths-heading`} className="text-sm font-medium">
        Paths
      </h3>
      <FieldDescription>The first path whose rules match is taken. If none matches, the run takes the “else” path. A path carries this step’s input on to the next step.</FieldDescription>
      {branches.map((branch, index) => (
        <BranchEditor
          key={index}
          branch={branch}
          index={index}
          idPrefix={idPrefix}
          groups={groups}
          disabled={disabled}
          onBranchChange={(next) => onChange(branches.map((candidate, position) => (position === index ? next : candidate)))}
          onRemove={branches.length > 1 ? () => onChange(branches.filter((_, position) => position !== index)) : undefined}
        />
      ))}
      <Button type="button" variant="outline" size="sm" className="self-start" disabled={disabled} onClick={() => onChange([...branches, { key: nextKey(branches), when: '' }])}>
        <IconPlus aria-hidden="true" />
        Add a path
      </Button>
      {(errors ?? []).map((message) => (
        <p key={message} className="text-destructive text-sm">
          {message}
        </p>
      ))}
    </section>
  );
}
