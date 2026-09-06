'use client';

/**
 * `<PromptTemplatePicker>` — the ONE shared prompt-template picker (TASK-890
 * REQ-6): "each agent's instruction is selected from the prompt list with a
 * quick view and a hyperlink to the prompt detail screen". Both consumers —
 * the agents form (L5) and the Studio `core.agent`/`core.trigger` inspector
 * (L6) — render THIS component rather than hand-rolling their own; it is the
 * only place that fetches `GET admin/prompt-templates` for a picker.
 *
 * ============================================================================
 * PROPS CONTRACT (stable — do not change the shape without updating BOTH
 * consumers; add fields rather than repurpose existing ones)
 * ============================================================================
 *   - `value` / `onChange` — the selected template id, `null` when none.
 *   - `category` — optional server-side filter (`PromptTemplateCategory`).
 *   - `onTemplateChange(template | null)` — fires whenever the resolved quick-
 *     view record changes (selection change OR the initial list/detail load
 *     resolving `value`), so a consumer can read `declaredVariables` for its
 *     OWN variable-binding UI without a second fetch of its own.
 *   - `disabled` / `errors` / `id` — the `Field` family's usual knobs.
 *
 * ============================================================================
 * WHAT IT RENDERS
 * ============================================================================
 * A labeled `Select` of the tenant's templates, and — once one is chosen — a
 * quick-view panel: status badge, "serving vN" / "not approved", the declared
 * variable names as chips, a content preview, and an "Open in Prompt
 * Templates" link to `/prompt-templates?template=<id>` (the existing deep
 * link `templates-tab.tsx` already opens the drawer at — this component never
 * embeds a second drawer).
 *
 * Degrades exactly like `AgentPickerField`: while the list is loading, a
 * skeleton; on an empty/error list, a slug `Input` fallback so authoring is
 * never blocked on this surface being unavailable.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { IconExternalLink } from '@tabler/icons-react';
import {
  Badge,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Label,
  Skeleton,
} from '@arcaai/ui';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { usePromptTemplateOptions, usePromptTemplateQuickView } from './hooks';
import type { PromptPickerStatus, PromptPickerTemplate } from './types';

const PROMPT_TEMPLATES_HREF = (id: string) => `/prompt-templates?template=${encodeURIComponent(id)}`;

/** Radix `Select` forbids an empty-string item value, so "no tag filter" needs a sentinel. */
const ALL_TAGS = '__all__';

const STATUS_LABEL: Record<PromptPickerStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  APPROVED: 'Approved',
};

function statusVariant(status: PromptPickerStatus): 'default' | 'secondary' | 'outline' {
  if (status === 'APPROVED') return 'default';
  if (status === 'PUBLISHED') return 'secondary';
  return 'outline';
}

export interface PromptTemplatePickerProps {
  id?: string;
  value: string | null;
  onChange: (id: string | null) => void;
  /** Narrow the list to one category (e.g. SUMMARY vs SYSTEM prompts). Omit for every category. */
  category?: string;
  disabled?: boolean;
  errors?: string[];
  /** Fires with the resolved quick-view record whenever it changes; `null` when nothing is selected/resolvable. */
  onTemplateChange?: (template: PromptPickerTemplate | null) => void;
}

/** Quick-view body — status, pin, variable chips, preview, deep link. Exported for the rare consumer that already holds the record. */
export function PromptTemplateQuickView({ template }: { template: PromptPickerTemplate }) {
  const variables = template.declaredVariables ?? [];
  return (
    <div data-testid="prompt-template-quick-view" className="border-border bg-muted/30 flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusVariant(template.status)}>{STATUS_LABEL[template.status] ?? template.status}</Badge>
        {template.approvedVersionNumber == null ? (
          <Badge
            variant="outline"
            className="font-mono text-xs"
            title="No version is pinned. Clinical resolution skips this template and falls through to the next tier."
          >
            not approved
          </Badge>
        ) : (
          <Badge
            variant={template.currentVersionNumber > template.approvedVersionNumber ? 'destructive' : 'secondary'}
            className="font-mono text-xs"
            title={
              template.currentVersionNumber > template.approvedVersionNumber
                ? `Resolution serves the pinned snapshot v${template.approvedVersionNumber}; the current content is v${template.currentVersionNumber} and will not run until re-approved.`
                : `Resolution serves the pinned snapshot v${template.approvedVersionNumber}, which is also the current content.`
            }
          >
            serving v{template.approvedVersionNumber}
            {template.currentVersionNumber > template.approvedVersionNumber ? ` · editing v${template.currentVersionNumber}` : ''}
          </Badge>
        )}
        <Link
          href={PROMPT_TEMPLATES_HREF(template.id)}
          className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs underline underline-offset-2"
        >
          Open in Prompt Templates <IconExternalLink aria-hidden="true" className="size-3" />
        </Link>
      </div>
      {(template.tags ?? []).length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Tags">
          {(template.tags ?? []).map((tag) => (
            <Badge key={tag} variant="secondary" className="rounded-full font-mono text-[11px]">
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}
      {variables.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Declared variables">
          {variables.map((variable) => (
            <Badge key={variable.name} variant="outline" className="rounded-full font-mono text-[11px]">
              {variable.name}
              {variable.required ? '' : '?'}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">No declared variables.</p>
      )}
      {template.contentPreview ? <p className="text-muted-foreground line-clamp-3 font-mono text-xs">{template.contentPreview}</p> : null}
    </div>
  );
}

export function PromptTemplatePicker({ id, value, onChange, category, disabled, errors, onTemplateChange }: PromptTemplatePickerProps) {
  const options = usePromptTemplateOptions(category ? { category } : undefined);
  const templates = options.data ?? [];
  const known = templates.find((template) => template.id === value);
  // Tag narrowing is CLIENT-side on purpose: the hook loads the tenant's whole
  // library in one page (`PICKER_LIMIT`), so filtering here is exact rather
  // than a page-local guess. `known` is resolved against the FULL list above,
  // so narrowing the options never orphans an already-bound template.
  const [tag, setTag] = useState('');
  // J3-6 — the field is labelled "Approved prompt template" on both consumers, and the agent
  // publish gate REFUSES a non-APPROVED binding (`TEMPLATE_NOT_APPROVED`). Offering unapproved
  // rows by default invites the author to pick something that cannot be published and only says
  // so three steps later. They are not HIDDEN, they are opted into: binding a draft while both
  // are in flight is legitimate, and the quick view already says "not approved".
  const [includeUnapproved, setIncludeUnapproved] = useState(false);
  const tagOptions = useMemo(
    // Keyed on the QUERY result, not the `?? []` fallback — that literal is a
    // new array every render and would re-run this on each one.
    () => [...new Set((options.data ?? []).flatMap((template) => template.tags ?? []))].sort((a, b) => a.localeCompare(b)),
    [options.data],
  );
  // Only a status we can READ as not-approved is narrowed away. An absent or unrecognised status
  // is not a verdict — a server that grows a state must not empty this picker — and the CURRENT
  // selection is always kept, because a picker that silently drops its own value is worse than
  // one showing a status it does not love.
  const unapproved = templates.filter((template) => template.status === 'DRAFT' || template.status === 'PUBLISHED');
  const byStatus = includeUnapproved ? templates : templates.filter((template) => !unapproved.includes(template) || template.id === value);
  const visible = tag ? byStatus.filter((template) => (template.tags ?? []).includes(tag)) : byStatus;
  // The selected id may not be in a category-filtered (or paginated) list —
  // fall back to a direct read so the quick view still resolves.
  const fallback = usePromptTemplateQuickView(value && !known ? value : null);
  const resolved = known ?? fallback.data ?? null;

  // Report the resolved record on every actual change (selection, or the
  // initial load resolving an already-set `value`) — never on every render.
  const lastReported = useRef<string | null>(null);
  useEffect(() => {
    const resolvedId = resolved?.id ?? null;
    if (lastReported.current === resolvedId) return;
    lastReported.current = resolvedId;
    onTemplateChange?.(resolved);
  }, [resolved, onTemplateChange]);

  const invalid = (errors?.length ?? 0) > 0 ? 'true' : undefined;
  const fieldId = id ?? 'prompt-template-picker';

  if (options.isPending) {
    return (
      <Field>
        <FieldLabel htmlFor={fieldId}>Prompt template</FieldLabel>
        <Skeleton className="h-9 w-full" />
      </Field>
    );
  }

  if (options.isError || templates.length === 0) {
    return (
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor={fieldId}>Prompt template id</FieldLabel>
        <FieldDescription>
          {options.isError ? 'The prompt list is unavailable — enter the template’s id.' : 'No prompt templates yet — enter an id, or create one.'}{' '}
          <Link href="/prompt-templates?create=1" className="inline-flex items-center gap-1 underline">
            Create template <IconExternalLink aria-hidden="true" className="size-3" />
          </Link>
        </FieldDescription>
        <Input
          id={fieldId}
          value={value ?? ''}
          disabled={disabled}
          className="font-mono"
          onChange={(event) => onChange(event.target.value || null)}
        />
        <FieldError errors={errors?.map((message) => ({ message }))} />
      </Field>
    );
  }

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={fieldId}>Prompt template</FieldLabel>
      <FieldDescription>The bound prompt&apos;s approved version is what actually runs — see the quick view below.</FieldDescription>
      {tagOptions.length > 0 ? (
        <Select value={tag || ALL_TAGS} onValueChange={(next) => setTag(next === ALL_TAGS ? '' : next)} disabled={disabled}>
          <SelectTrigger id={`${fieldId}-tag`} aria-label="Filter by tag" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TAGS}>All tags</SelectItem>
            {tagOptions.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {unapproved.length > 0 ? (
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${fieldId}-include-drafts`}
            checked={includeUnapproved}
            disabled={disabled}
            onCheckedChange={(checked) => setIncludeUnapproved(checked === true)}
          />
          <Label htmlFor={`${fieldId}-include-drafts`} className="text-muted-foreground text-xs font-normal">
            Include drafts ({unapproved.length}) — an unapproved template cannot be published on an agent
          </Label>
        </div>
      ) : null}
      <Select value={known ? value! : ''} onValueChange={(next) => onChange(next || null)} disabled={disabled}>
        <SelectTrigger id={fieldId} className="w-full">
          <SelectValue placeholder={value && !known ? `${value} (not in the list)` : 'Choose a prompt template'} />
        </SelectTrigger>
        <SelectContent>
          {visible.map((template) => (
            <SelectItem key={template.id} value={template.id}>
              {template.name} <span className="text-muted-foreground font-mono text-xs">{STATUS_LABEL[template.status] ?? template.status}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError errors={errors?.map((message) => ({ message }))} />
      {resolved ? <PromptTemplateQuickView template={resolved} /> : null}
    </Field>
  );
}
