'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { deriveVariableDeclarations } from '@arcaai/workflow-contract';
import { IconEraser, IconPlus, IconTrash, IconWand } from '@tabler/icons-react';
import { cn } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { GatewayError } from '@/shared/api';
import { TemplateField, templateSyntaxLint, variableNamePaths, withPlatformPaths } from '@/shared/template-editor';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { TagsField } from '@/shared/tags-field';
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
 * The variable-declarations repeater (TASK-890 §3.6, "Derive v2" TASK-1036 §3.1) — shared by the
 * create and edit forms. "Derive from content" calls `deriveVariableDeclarations`
 * (`@arcaai/workflow-contract`), the SAME function the server runs on create/update, so the list
 * shown here is the list stored: one declaration per ROOT name (`{{a.b}}` declares `a`, as JSON),
 * existing declarations kept verbatim, and namespace roots (`trigger`, `context`, …) and platform
 * variables never offered. A declaration the content no longer references is shown STALE and is
 * only removed after the author confirms ("Remove stale").
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
  const [confirmingStale, setConfirmingStale] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  // A row the author has not named yet is not "stale" — it is unfinished.
  const stale = useMemo(
    () => new Set(deriveVariableDeclarations(content, variables).stale.filter((name) => name !== '')),
    [content, variables],
  );

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
    const result = deriveVariableDeclarations(content, variables);
    if (result.added.length > 0) onChange(result.declarations);
    const count = result.added.length;
    setAnnouncement(count === 0 ? 'No new variables found.' : `Added ${count} ${count === 1 ? 'variable' : 'variables'}: ${result.added.join(', ')}.`);
  }

  function removeStale() {
    onChange(variables.filter((variable) => !stale.has(variable.name)));
    setAnnouncement(`Removed ${stale.size} stale ${stale.size === 1 ? 'variable' : 'variables'}.`);
    setConfirmingStale(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Variables</span>
        <div className="flex items-center gap-2">
          {stale.size > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingStale(true)}>
              <IconEraser aria-hidden />
              Remove stale ({stale.size})
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={deriveFromContent}>
            <IconWand aria-hidden />
            Derive from content
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Optional variables render empty when no value is provided. Required variables must be supplied, or the prompt fails by name.
      </p>
      <p role="status" className="text-muted-foreground text-xs empty:sr-only">
        {announcement}
      </p>
      <ConfirmDialog
        open={confirmingStale}
        onOpenChange={setConfirmingStale}
        title="Remove stale variables?"
        description={`These declarations are no longer referenced by the prompt content: ${[...stale].join(', ')}.`}
        confirmLabel="Remove stale variables"
        onConfirm={removeStale}
      />
      {variables.length === 0 ? <p className="text-muted-foreground text-xs">No declared variables yet.</p> : null}
      {variables.map((variable, index) => (
        <div key={index} className="grid grid-cols-1 items-end gap-2 rounded-md border p-2 sm:grid-cols-12">
          <div className="flex flex-col gap-1 sm:col-span-3">
            <Label htmlFor={`variable-name-${index}`} className="text-xs">
              Name
              {stale.has(variable.name) ? (
                <Badge variant="outline" className="ml-1.5 text-[10px]">
                  no longer used
                </Badge>
              ) : null}
            </Label>
            <Input
              id={`variable-name-${index}`}
              value={variable.name}
              onChange={(event) => updateAt(index, { name: event.target.value })}
              placeholder="topic"
              className={cn('font-mono text-xs', stale.has(variable.name) && 'text-muted-foreground line-through')}
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

const TAGS_DESCRIPTION = (
  <>
    Tags select prompts at resolution time (<span className="font-mono">pre-summary</span>) and carry the department axis as{' '}
    <span className="font-mono">dept:&lt;slug&gt;</span>.
  </>
);

function RequiredMark() {
  return (
    <span aria-hidden className="text-destructive">
      *
    </span>
  );
}

/**
 * The template body: a `TemplateEditor` completing the template's own declared variables and
 * flagging a placeholder that does not parse. Which `context.*` paths resolve is decided by each
 * agent that binds the template, so the body is checked for syntax only here; the binding agent's
 * publish (and its editor) checks the references.
 */
function TemplateContentField({
  value,
  onChange,
  variables,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  variables: PromptVariableDeclaration[];
  placeholder?: string;
}) {
  // The template's own declarations, then the platform's `context.*` names a binding agent resolves.
  const paths = withPlatformPaths(
    variableNamePaths(
      variables.map((variable) => variable.name),
      'declared',
    ),
  );
  return (
    <div className="flex min-h-40 flex-1 flex-col">
      <TemplateField
        label="Prompt content"
        required
        value={value}
        onChange={onChange}
        paths={paths}
        lint={templateSyntaxLint}
        minLines={10}
        placeholder={placeholder}
      />
    </div>
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
      <TemplateContentField
        value={content}
        onChange={setContent}
        variables={variables}
        placeholder={'You are a clinical scribe. Summarize {{transcript}} as…'}
      />
      <PromptVariablesEditor variables={variables} onChange={setVariables} content={content} />
      <TagsField id="create-template-tags" value={tags} onChange={setTags} description={TAGS_DESCRIPTION} />
      <FormActions>
        <Button type="button" variant="outline" onClick={onCancel} disabled={createTemplate.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || !content || createTemplate.isPending}>
          {createTemplate.isPending ? <Spinner /> : null}
          Create Hope Prompt
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
      <TemplateContentField value={content} onChange={setContent} variables={variables} />
      <PromptVariablesEditor variables={variables} onChange={setVariables} content={content} />
      <TagsField id="edit-template-tags" value={tags} onChange={setTags} description={TAGS_DESCRIPTION} />
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
