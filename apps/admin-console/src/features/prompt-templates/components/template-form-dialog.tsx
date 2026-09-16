'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { templateReferences } from '@arcaai/workflow-contract';
import { IconPlus, IconTrash, IconWand, IconX } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { useCreateTemplate, useDepartments, useUpdateTemplate } from '../api/hooks';
import type { PromptTemplate, PromptTemplateCategory, PromptTemplateStatus, PromptVariableDeclaration, PromptVariableType } from '../api/types';

const VARIABLE_TYPE_OPTIONS: { value: PromptVariableType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'json', label: 'JSON' },
];

/**
 * The variable-declarations repeater (TASK-890 §3.6) — shared by the create
 * and edit forms. "Derive from content" reads every `{{path}}` reference in
 * the template body via `templateReferences` (`@arcaai/workflow-contract`,
 * the SAME parser the publish gate and the render engine use) and adds one
 * declaration per ROOT name not already declared — `{{a.b}}` derives `a`, not
 * `a.b`, with a hint noting the fuller path it was referenced by.
 */
function PromptVariablesEditor({
  variables,
  onChange,
  content,
}: {
  variables: PromptVariableDeclaration[];
  onChange: (next: PromptVariableDeclaration[]) => void;
  content: string;
}) {
  function updateAt(index: number, patch: Partial<PromptVariableDeclaration>) {
    onChange(variables.map((variable, i) => (i === index ? { ...variable, ...patch } : variable)));
  }

  function removeAt(index: number) {
    onChange(variables.filter((_, i) => i !== index));
  }

  function addVariable() {
    onChange([...variables, { name: '', type: 'string', required: false }]);
  }

  function deriveFromContent() {
    let refs: ReturnType<typeof templateReferences>;
    try {
      refs = templateReferences(content);
    } catch {
      // A syntax error in the content is reported by the publish gate, not
      // this best-effort authoring helper — just derive nothing.
      return;
    }
    const known = new Set(variables.map((variable) => variable.name));
    const derived: PromptVariableDeclaration[] = [];
    for (const ref of refs) {
      const root = ref.path.split('.')[0];
      if (known.has(root)) continue;
      known.add(root);
      derived.push({
        name: root,
        type: 'string',
        required: !ref.hasDefault,
        ...(ref.path !== root ? { description: `Referenced as {{${ref.path}}}` } : {}),
      });
    }
    if (derived.length > 0) onChange([...variables, ...derived]);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Variables</span>
        <Button type="button" variant="outline" size="sm" onClick={deriveFromContent}>
          <IconWand aria-hidden />
          Derive from content
        </Button>
      </div>
      {variables.length === 0 ? <p className="text-muted-foreground text-xs">No declared variables yet.</p> : null}
      {variables.map((variable, index) => (
        <div key={index} className="grid grid-cols-1 items-end gap-2 rounded-md border p-2 sm:grid-cols-12">
          <div className="flex flex-col gap-1 sm:col-span-3">
            <Label htmlFor={`variable-name-${index}`} className="text-xs">
              Name
            </Label>
            <Input
              id={`variable-name-${index}`}
              value={variable.name}
              onChange={(event) => updateAt(index, { name: event.target.value })}
              placeholder="topic"
              className="font-mono text-xs"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label htmlFor={`variable-type-${index}`} className="text-xs">
              Type
            </Label>
            <Select value={variable.type} onValueChange={(next) => updateAt(index, { type: next as PromptVariableType })}>
              <SelectTrigger id={`variable-type-${index}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VARIABLE_TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label htmlFor={`variable-default-${index}`} className="text-xs">
              Default
            </Label>
            <Input
              id={`variable-default-${index}`}
              value={variable.default ?? ''}
              onChange={(event) => updateAt(index, { default: event.target.value || undefined })}
              className="text-xs"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-3">
            <Label htmlFor={`variable-description-${index}`} className="text-xs">
              Description
            </Label>
            <Input
              id={`variable-description-${index}`}
              value={variable.description ?? ''}
              onChange={(event) => updateAt(index, { description: event.target.value || undefined })}
              className="text-xs"
              autoComplete="off"
            />
          </div>
          <div className="flex items-center gap-1.5 sm:col-span-1">
            <Switch
              id={`variable-required-${index}`}
              checked={variable.required}
              onCheckedChange={(checked) => updateAt(index, { required: checked })}
            />
            <Label htmlFor={`variable-required-${index}`} className="text-xs">
              Req.
            </Label>
          </div>
          <div className="flex justify-end sm:col-span-1">
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${variable.name || 'variable'}`} onClick={() => removeAt(index)}>
              <IconTrash aria-hidden />
            </Button>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={addVariable}>
        <IconPlus aria-hidden />
        Add variable
      </Button>
    </div>
  );
}

const CATEGORY_OPTIONS: { value: PromptTemplateCategory; label: string }[] = [
  { value: 'SYSTEM', label: 'System' },
  { value: 'SUMMARY', label: 'Summary' },
  { value: 'DNA_ANALYSIS', label: 'DNA analysis' },
  { value: 'CUSTOM', label: 'Custom' },
];

const STATUS_OPTIONS: { value: PromptTemplateStatus; label: string }[] = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PUBLISHED', label: 'Published' },
];

/**
 * Tag editor (chips + an add box) — shared by the create and edit forms.
 *
 * `PromptTemplate` is a TAGGED entity end to end (column, create/update DTOs,
 * response) and tags are already load-bearing at RESOLUTION time — the
 * tenant-wide pre-summary is picked by the `pre-summary` tag, minus
 * `dept-free` — yet the console had no way to read or write them. With the
 * `departmentId` scope being deprecated in favour of `dept:<slug>` tags, an
 * admin who cannot edit tags cannot steer resolution at all.
 *
 * Enter or a comma commits; a comma-separated paste adds several at once.
 * Duplicates and blanks are dropped, and order is preserved (the resolver's
 * tie-breaks are by row, never by tag order, so this is purely cosmetic).
 */
function TagsField({ idPrefix, tags, onChange }: { idPrefix: string; tags: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');

  function commit(raw: string) {
    const added = raw
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (added.length === 0) return;
    const next = [...tags];
    for (const tag of added) if (!next.includes(tag)) next.push(tag);
    onChange(next);
    setDraft('');
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${idPrefix}-tags`}>Tags</Label>
      {tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((tag) => (
            <Badge key={tag} variant="outline" className="rounded-full py-0.5 pr-1 font-mono text-[11px]">
              {tag}
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                className="text-muted-foreground hover:text-foreground ml-1 cursor-pointer rounded-full"
                onClick={() => onChange(tags.filter((entry) => entry !== tag))}
              >
                <IconX aria-hidden className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
      <Input
        id={`${idPrefix}-tags`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ',') return;
          event.preventDefault();
          commit(draft);
        }}
        onBlur={() => commit(draft)}
        placeholder="dept:cardiology — Enter to add"
        autoComplete="off"
      />
      <p className="text-muted-foreground text-xs">
        Tags select prompts at resolution time (<span className="font-mono">pre-summary</span>) and carry the department axis as{' '}
        <span className="font-mono">dept:&lt;slug&gt;</span>.
      </p>
    </div>
  );
}

function RequiredMark() {
  return (
    <span aria-hidden className="text-destructive">
      *
    </span>
  );
}

/** Footer row shared by the two forms — the drawer body owns scrolling, this stays inline. */
function FormActions({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>;
}

/**
 * Create form body (no dialog chrome) — hosted in the console-wide `DetailDrawer`
 * create mode. POST /admin/prompt-templates; v1 content is created server-side.
 */
export function CreateTemplateForm({ onCreated, onCancel }: { onCreated: (template: PromptTemplate) => void; onCancel: () => void }) {
  const createTemplate = useCreateTemplate();
  const departmentsQuery = useDepartments();
  const [name, setName] = useState('');
  const [category, setCategory] = useState<PromptTemplateCategory>('SUMMARY');
  const [status, setStatus] = useState<PromptTemplateStatus>('DRAFT');
  const [departmentId, setDepartmentId] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [variables, setVariables] = useState<PromptVariableDeclaration[]>([]);
  const [tags, setTags] = useState<string[]>([]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createTemplate.mutate(
      {
        name: name.trim(),
        category,
        status,
        content,
        description: description.trim() || undefined,
        departmentId: departmentId || undefined,
        variables: variables.length > 0 ? variables : undefined,
        tags: tags.length > 0 ? tags : undefined,
      },
      {
        onSuccess: (template) => {
          toast.success(`Template "${template.name}" created`);
          onCreated(template);
        },
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the template.'),
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="create-template-name">
            Name <RequiredMark />
          </Label>
          <Input
            id="create-template-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Cardiology Notes"
            autoComplete="off"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="create-template-category">
            Category <RequiredMark />
          </Label>
          <Select value={category} onValueChange={(next) => setCategory(next as PromptTemplateCategory)}>
            <SelectTrigger id="create-template-category" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="create-template-status">Status</Label>
          <Select value={status} onValueChange={(next) => setStatus(next as PromptTemplateStatus)}>
            <SelectTrigger id="create-template-status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="create-template-department">Department</Label>
          <Select value={departmentId || 'none'} onValueChange={(next) => setDepartmentId(next === 'none' ? '' : next)}>
            <SelectTrigger id="create-template-department" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">All departments</SelectItem>
              {(departmentsQuery.data ?? []).map((department) => (
                <SelectItem key={department.id} value={department.id}>
                  {department.code ?? department.name ?? department.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="create-template-description">Description</Label>
        <Input
          id="create-template-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What this agent produces"
          autoComplete="off"
        />
      </div>
      <div className="flex min-h-40 flex-1 flex-col gap-2">
        <Label htmlFor="create-template-content">
          Prompt content <RequiredMark />
        </Label>
        <Textarea
          id="create-template-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={'You are a clinical scribe. Summarize {{transcript}} as…'}
          className="min-h-40 flex-1 resize-none font-mono text-xs"
          required
        />
      </div>
      <PromptVariablesEditor variables={variables} onChange={setVariables} content={content} />
      <TagsField idPrefix="create-template" tags={tags} onChange={setTags} />
      <FormActions>
        <Button type="button" variant="outline" onClick={onCancel} disabled={createTemplate.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || !content || createTemplate.isPending}>
          {createTemplate.isPending ? <Spinner /> : null}
          Create template
        </Button>
      </FormActions>
    </form>
  );
}

/**
 * Edit form body (no dialog chrome) — hosted in the drawer's Overview tab.
 * PATCH /admin/prompt-templates/:id with optimistic concurrency; a content edit
 * bumps currentVersionNumber server-side (new PromptVersion row). 412/428 render
 * the inline OCC alert instead of a toast.
 */
export function EditTemplateForm({
  template,
  etag,
  onSaved,
  onReload,
}: {
  template: PromptTemplate;
  etag: string | null;
  onSaved: () => void;
  onReload: () => void;
}) {
  const updateTemplate = useUpdateTemplate();
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? '');
  const [content, setContent] = useState(template.content);
  const [status, setStatus] = useState<PromptTemplateStatus>(template.status);
  const [variables, setVariables] = useState<PromptVariableDeclaration[]>(template.declaredVariables ?? []);
  const [tags, setTags] = useState<string[]>(template.tags ?? []);
  const [changeReason, setChangeReason] = useState('');
  /**
   * `PATCH :id` accepts DRAFT|PUBLISHED only — APPROVED is granted by
   * `POST :id/approve`, never by an edit. So an APPROVED row needs its own
   * (non-settable) entry here, or the Select renders an EMPTY trigger and the
   * form has no honest way to show what the row's status actually is.
   */
  const statusOptions = template.status === 'APPROVED' ? [...STATUS_OPTIONS, { value: 'APPROVED' as const, label: 'Approved' }] : STATUS_OPTIONS;
  // Save is offered only once a saved field differs from the loaded row: a
  // pristine PATCH changes nothing, and the service refuses it (400). The change
  // reason alone is not a change — it annotates the version a real edit creates.
  const isDirty =
    name.trim() !== template.name ||
    (description.trim() || null) !== (template.description || null) ||
    content !== template.content ||
    status !== template.status ||
    JSON.stringify(variables) !== JSON.stringify(template.declaredVariables ?? []) ||
    JSON.stringify(tags) !== JSON.stringify(template.tags ?? []);
  const occError =
    updateTemplate.error instanceof GatewayError && (updateTemplate.error.isVersionConflict || updateTemplate.error.isMissingPrecondition)
      ? updateTemplate.error
      : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!etag) return;
    updateTemplate.mutate(
      {
        id: template.id,
        patch: {
          name: name.trim(),
          description: description.trim() || undefined,
          content,
          // Only a CHANGED status travels. Sending the row's current status
          // back is a no-op for every value except APPROVED, which the update
          // DTO rejects outright (400) — which is how editing any approved
          // template used to fail, including every cloned SYSTEM prompt.
          ...(status === template.status ? {} : { status }),
          variables,
          tags,
          changeReason: changeReason.trim() || undefined,
        },
        etag,
      },
      {
        onSuccess: () => {
          toast.success('Template updated');
          onSaved();
        },
        onError: (error) => {
          // A 412/428 renders the inline OCC alert instead of a toast.
          if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
          toast.error(error instanceof GatewayError ? error.message : 'Could not update the template.');
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
      <OccConflictAlert
        error={occError}
        onReload={() => {
          // Keeps the local edits; the refetched ETag arms the next save.
          onReload();
          updateTemplate.reset();
        }}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="edit-template-name">
            Name <RequiredMark />
          </Label>
          <Input
            id="edit-template-name"
            aria-label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="edit-template-status">Status</Label>
          <Select value={status} onValueChange={(next) => setStatus(next as PromptTemplateStatus)}>
            <SelectTrigger id="edit-template-status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="edit-template-description">Description</Label>
        <Input id="edit-template-description" value={description} onChange={(event) => setDescription(event.target.value)} autoComplete="off" />
      </div>
      <div className="flex min-h-40 flex-1 flex-col gap-2">
        <Label htmlFor="edit-template-content">
          Prompt content <RequiredMark />
        </Label>
        <Textarea
          id="edit-template-content"
          aria-label="Prompt content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          className="min-h-40 flex-1 resize-none font-mono text-xs"
          required
        />
      </div>
      <PromptVariablesEditor variables={variables} onChange={setVariables} content={content} />
      <TagsField idPrefix="edit-template" tags={tags} onChange={setTags} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="edit-template-change-reason">Change reason</Label>
        <Input
          id="edit-template-change-reason"
          value={changeReason}
          onChange={(event) => setChangeReason(event.target.value)}
          placeholder="Stored in the version history"
          autoComplete="off"
        />
      </div>
      <FormActions>
        {isDirty ? null : <p className="text-sm text-muted-foreground">No changes to save</p>}
        <Button type="submit" disabled={!isDirty || !name.trim() || !content || !etag || updateTemplate.isPending}>
          {updateTemplate.isPending ? <Spinner /> : null}
          Save changes
        </Button>
      </FormActions>
    </form>
  );
}
