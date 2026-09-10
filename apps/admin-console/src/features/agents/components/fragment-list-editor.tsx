'use client';

/**
 * TASK-947 §4.1/OD-2/OD-12 — the "composable fragments" instruction editor: an ORDERED list of
 * prompt fragments, each a template reference or an inline body, each with an optional CEL
 * `when` condition (absent ⇒ always included — the "base"; at least one base fragment is
 * required, mirroring the server's `PROMPT_COMPOSITION_NO_BASE` publish gate). Reordering is
 * offered as up/down buttons — the WCAG 2.5.7 single-pointer alternative by construction, same
 * pattern as `document-templates/components/section-form.tsx` — never a drag-only interaction.
 *
 * `instruction.variables` stays ONE agent-level map (OD-8): this editor renders ONE "Variable
 * bindings" fieldset over the UNION of every template-sourced fragment's declared variables,
 * deduped by name; the same name declared with a different `type` by two templates is flagged
 * inline (mirrors the server's `PROMPT_VARIABLE_CONFLICT`).
 *
 * Server-side validation is authoritative (publish re-checks everything); the messages here are
 * a front door so an author sees the same shape of problem before spending a publish round-trip.
 */
import { useId, useState } from 'react';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { Badge, Button, Input, Label, RadioGroup, RadioGroupItem, Textarea } from '@arcaai/ui';
import { PromptTemplatePicker, type PromptPickerTemplate, type PromptPickerVariableDeclaration } from '@/shared/prompt-picker';
import { FRAGMENT_KEY_PATTERN, FRAGMENT_WHEN_MAX_LENGTH, MAX_FRAGMENTS, type AgentPromptVariableBinding, type PromptFragment } from '../api';
import { VariableBindingsFieldset } from './variable-bindings-fieldset';
import { VersionPinControl } from './version-pin-control';

export interface FragmentRow {
  key: string;
  source: 'template' | 'inline';
  promptTemplateId: string | null;
  /** `null` ⇒ follow the template's own approved version. Only meaningful when `source === 'template'`. */
  promptVersionNumber: number | null;
  /** Only meaningful when `source === 'inline'`. */
  systemPrompt: string;
  /** CEL string; `''` ⇒ no condition (always included). */
  when: string;
}

export function defaultFragmentRow(): FragmentRow {
  return { key: '', source: 'template', promptTemplateId: null, promptVersionNumber: null, systemPrompt: '', when: '' };
}

/** `Agent.instruction.fragments` (persisted JSON) → editor rows, in authored order. */
export function fragmentRowsFromFragments(fragments: PromptFragment[]): FragmentRow[] {
  return fragments.map((fragment) => {
    const source: FragmentRow['source'] = typeof fragment.promptTemplateId === 'string' ? 'template' : 'inline';
    return {
      key: fragment.key,
      source,
      promptTemplateId: source === 'template' ? (fragment.promptTemplateId ?? null) : null,
      promptVersionNumber: typeof fragment.promptVersionNumber === 'number' ? fragment.promptVersionNumber : null,
      systemPrompt: source === 'inline' ? (fragment.systemPrompt ?? '') : '',
      when: fragment.when ?? '',
    };
  });
}

/** Editor rows → `Agent.instruction.fragments`, in authored order — the inverse of `fragmentRowsFromFragments`. */
export function fragmentsFromRows(rows: FragmentRow[]): PromptFragment[] {
  return rows.map((row) => {
    const fragment: PromptFragment = { key: row.key };
    if (row.source === 'template') {
      fragment.promptTemplateId = row.promptTemplateId ?? '';
      if (row.promptVersionNumber !== null) fragment.promptVersionNumber = row.promptVersionNumber;
    } else {
      fragment.systemPrompt = row.systemPrompt;
    }
    if (row.when.trim().length > 0) fragment.when = row.when;
    return fragment;
  });
}

function moveItem<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * Front-door validation mirroring the server's publish gate (§4.1/§4.3): duplicate keys, a
 * malformed key, a missing base (no fragment without `when`), a fragment with no content
 * selected for its source, an over-long condition, and the 1–16 count bound.
 */
export function fragmentListProblems(rows: FragmentRow[]): string[] {
  const problems: string[] = [];
  if (rows.length > MAX_FRAGMENTS) problems.push(`At most ${MAX_FRAGMENTS} fragments are allowed (${rows.length} present).`);

  const keyCounts = new Map<string, number>();
  rows.forEach((row, index) => {
    const label = row.key ? `"${row.key}"` : `Fragment ${index + 1}`;
    if (!row.key) {
      problems.push(`Fragment ${index + 1} needs a key.`);
    } else if (!FRAGMENT_KEY_PATTERN.test(row.key)) {
      problems.push(`${label} must be 2–48 lowercase letters, digits, or underscores.`);
    } else {
      keyCounts.set(row.key, (keyCounts.get(row.key) ?? 0) + 1);
    }
    if (row.source === 'template' && !row.promptTemplateId) {
      problems.push(`${label} needs a prompt template — or switch it to an inline prompt.`);
    }
    if (row.source === 'inline' && row.systemPrompt.trim().length === 0) {
      problems.push(`${label} needs inline prompt text — or switch it to a template.`);
    }
    if (row.when.length > FRAGMENT_WHEN_MAX_LENGTH) {
      problems.push(`${label}'s condition is too long (max ${FRAGMENT_WHEN_MAX_LENGTH} characters).`);
    }
  });
  for (const [key, count] of keyCounts) {
    if (count > 1) problems.push(`Duplicate fragment key: "${key}" is used ${count} times.`);
  }
  if (rows.length > 0 && !rows.some((row) => row.when.trim().length === 0)) {
    problems.push('At least one fragment must have no condition — this is the base that always applies.');
  }
  return problems;
}

interface DeclaredVariablesUnion {
  declared: PromptPickerVariableDeclaration[];
  conflicts: string[];
}

/** OD-8 — the union of declared variables across every TEMPLATE-sourced fragment, deduped by name; a name declared with a different `type` by two templates is a conflict. */
function unionDeclaredVariables(templates: Array<{ name: string; declaredVariables: PromptPickerVariableDeclaration[] }>): DeclaredVariablesUnion {
  const firstByName = new Map<string, PromptPickerVariableDeclaration>();
  const sourcesByNameAndType = new Map<string, Map<string, Set<string>>>();
  for (const template of templates) {
    for (const declaration of template.declaredVariables) {
      if (!firstByName.has(declaration.name)) firstByName.set(declaration.name, declaration);
      const byType = sourcesByNameAndType.get(declaration.name) ?? new Map<string, Set<string>>();
      const sources = byType.get(declaration.type) ?? new Set<string>();
      sources.add(template.name);
      byType.set(declaration.type, sources);
      sourcesByNameAndType.set(declaration.name, byType);
    }
  }
  const conflicts: string[] = [];
  for (const [name, byType] of sourcesByNameAndType) {
    if (byType.size <= 1) continue;
    const parts = [...byType.entries()].map(([type, sources]) => `${type} (${[...sources].join(', ')})`);
    conflicts.push(`Variable "${name}" is declared differently by more than one fragment template: ${parts.join(' vs. ')}.`);
  }
  return { declared: [...firstByName.values()], conflicts };
}

const WHEN_HELP_ID_SUFFIX = '-when-help';

function FragmentRowEditor({
  row,
  index,
  count,
  onChange,
  onMove,
  onRemove,
  onTemplateResolved,
  disabled,
}: {
  row: FragmentRow;
  index: number;
  count: number;
  onChange: (next: FragmentRow) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onTemplateResolved: (template: PromptPickerTemplate | null) => void;
  disabled?: boolean;
}) {
  const idPrefix = useId();
  const [template, setTemplate] = useState<PromptPickerTemplate | null>(null);
  const label = row.key || `Fragment ${index + 1}`;

  function patch(next: Partial<FragmentRow>) {
    onChange({ ...row, ...next });
  }

  function handleTemplateResolved(next: PromptPickerTemplate | null) {
    setTemplate(next);
    onTemplateResolved(next);
  }

  return (
    <li className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          Position {index + 1} of {count}
          {!row.when.trim() ? (
            <Badge variant="secondary" className="ml-2">
              Base
            </Badge>
          ) : null}
        </span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled || index === 0} onClick={() => onMove(-1)} aria-label={`Move ${label} up`}>
            <IconArrowUp aria-hidden />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || index === count - 1}
            onClick={() => onMove(1)}
            aria-label={`Move ${label} down`}
          >
            <IconArrowDown aria-hidden />
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onRemove} aria-label={`Remove ${label}`}>
            <IconTrash aria-hidden />
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-key`}>
          Key <span aria-hidden className="text-destructive">*</span>
        </Label>
        <Input
          id={`${idPrefix}-key`}
          className="max-w-64 font-mono"
          value={row.key}
          disabled={disabled}
          placeholder="base"
          onChange={(event) => patch({ key: event.target.value })}
        />
        <p className="text-muted-foreground text-xs">2–48 lowercase letters, digits, or underscores. Unique within this agent.</p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Content</legend>
        <RadioGroup
          value={row.source}
          onValueChange={(source) =>
            patch(
              source === 'template'
                ? { source: 'template', systemPrompt: '' }
                : { source: 'inline', promptTemplateId: null, promptVersionNumber: null },
            )
          }
          aria-label={`${label} content source`}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem id={`${idPrefix}-source-template`} value="template" disabled={disabled} />
            <Label htmlFor={`${idPrefix}-source-template`}>Use a prompt template</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id={`${idPrefix}-source-inline`} value="inline" disabled={disabled} />
            <Label htmlFor={`${idPrefix}-source-inline`}>Use an inline prompt</Label>
          </div>
        </RadioGroup>
      </fieldset>

      {row.source === 'template' ? (
        <>
          <PromptTemplatePicker
            id={`${idPrefix}-template`}
            value={row.promptTemplateId}
            onChange={(id) => patch({ promptTemplateId: id, promptVersionNumber: null })}
            onTemplateChange={handleTemplateResolved}
            disabled={disabled}
          />
          {row.promptTemplateId && template ? (
            <VersionPinControl
              idPrefix={idPrefix}
              approvedVersionNumber={template.approvedVersionNumber}
              currentVersionNumber={template.currentVersionNumber}
              value={row.promptVersionNumber}
              onChange={(promptVersionNumber) => patch({ promptVersionNumber })}
              disabled={disabled}
            />
          ) : null}
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-inline`}>
            Inline prompt <span aria-hidden className="text-destructive">*</span>
          </Label>
          <Textarea
            id={`${idPrefix}-inline`}
            rows={5}
            maxLength={50000}
            value={row.systemPrompt}
            disabled={disabled}
            onChange={(event) => patch({ systemPrompt: event.target.value })}
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-when`}>Condition (optional)</Label>
        <Input
          id={`${idPrefix}-when`}
          className="font-mono"
          value={row.when}
          disabled={disabled}
          placeholder="has(context.visit_type) && context.visit_type == 'revisit'"
          aria-describedby={`${idPrefix}${WHEN_HELP_ID_SUFFIX}`}
          onChange={(event) => patch({ when: event.target.value })}
        />
        <p id={`${idPrefix}${WHEN_HELP_ID_SUFFIX}`} className="text-muted-foreground text-xs">
          A CEL expression over <code className="font-mono">context</code>, <code className="font-mono">trigger</code>,{' '}
          <code className="font-mono">input</code>, <code className="font-mono">vars</code>, <code className="font-mono">nodes</code>, or a bound
          variable name. Leave empty to always include this fragment — guard a possibly-missing field with{' '}
          <code className="font-mono">has(...)</code>, e.g. <code className="font-mono">has(context.visit_type) &amp;&amp; context.visit_type == &apos;revisit&apos;</code>.
        </p>
      </div>
    </li>
  );
}

export interface FragmentListEditorProps {
  fragments: FragmentRow[];
  onFragmentsChange: (fragments: FragmentRow[]) => void;
  variables: Record<string, AgentPromptVariableBinding>;
  onVariablesChange: (variables: Record<string, AgentPromptVariableBinding>) => void;
  disabled?: boolean;
}

export function FragmentListEditor({ fragments, onFragmentsChange, variables, onVariablesChange, disabled }: FragmentListEditorProps) {
  const listIdPrefix = useId();
  // Keyed by index — a fragment's POSITION, not its (user-editable, possibly duplicate) key.
  // Reordering re-renders the same row instances with new props, which re-resolves correctly
  // (same pattern as `PromptTemplatePicker`'s own async resolution elsewhere in this feature).
  const [templatesByIndex, setTemplatesByIndex] = useState<Record<number, PromptPickerTemplate | null>>({});
  const problems = fragmentListProblems(fragments);

  const templateEntries = fragments
    .map((row, index) => ({ row, template: templatesByIndex[index] }))
    .filter((entry): entry is { row: FragmentRow; template: PromptPickerTemplate } => entry.row.source === 'template' && !!entry.template)
    .map((entry) => ({ name: entry.template.name, declaredVariables: entry.template.declaredVariables ?? [] }));
  const { declared, conflicts } = unionDeclaredVariables(templateEntries);

  function updateRow(index: number, next: FragmentRow) {
    onFragmentsChange(fragments.map((row, i) => (i === index ? next : row)));
  }

  function removeRow(index: number) {
    onFragmentsChange(fragments.filter((_, i) => i !== index));
    setTemplatesByIndex((current) => {
      const next: Record<number, PromptPickerTemplate | null> = {};
      for (const [key, value] of Object.entries(current)) {
        const i = Number(key);
        if (i === index) continue;
        next[i > index ? i - 1 : i] = value;
      }
      return next;
    });
  }

  function moveRow(index: number, delta: -1 | 1) {
    const next = moveItem(fragments, index, delta);
    if (next !== fragments) onFragmentsChange(next);
  }

  function addRow() {
    onFragmentsChange([...fragments, defaultFragmentRow()]);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          Fragments ({fragments.length}/{MAX_FRAGMENTS})
        </h3>
        <Button type="button" size="sm" variant="outline" disabled={disabled || fragments.length >= MAX_FRAGMENTS} onClick={addRow}>
          <IconPlus aria-hidden />
          Add fragment
        </Button>
      </div>

      {fragments.length === 0 ? (
        <p className="text-muted-foreground text-sm">No fragments yet. Add one to start — the first fragment with no condition is the base.</p>
      ) : (
        <ol className="flex flex-col gap-3" aria-label={`Fragments (${fragments.length})`}>
          {fragments.map((row, index) => (
            <FragmentRowEditor
              key={index}
              row={row}
              index={index}
              count={fragments.length}
              disabled={disabled}
              onChange={(next) => updateRow(index, next)}
              onMove={(delta) => moveRow(index, delta)}
              onRemove={() => removeRow(index)}
              onTemplateResolved={(template) => setTemplatesByIndex((current) => ({ ...current, [index]: template }))}
            />
          ))}
        </ol>
      )}

      {problems.length > 0 ? (
        <ul className="flex flex-col gap-0.5" aria-label="Fragment list problems">
          {problems.map((problem) => (
            <li key={problem} className="text-destructive text-sm">
              {problem}
            </li>
          ))}
        </ul>
      ) : null}

      <VariableBindingsFieldset idPrefix={listIdPrefix} declared={declared} variables={variables} onChange={onVariablesChange} conflicts={conflicts} disabled={disabled} />
    </div>
  );
}
