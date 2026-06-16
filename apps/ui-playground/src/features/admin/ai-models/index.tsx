import { zodResolver } from '@/lib/zod-resolver';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Building2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@arcaai/ui/form';
import { Input } from '@arcaai/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import type { ColumnDef } from '@tanstack/react-table';

import { Main } from '@/components/layout/main';
import { useAuthStore } from '@/store/auth-store';

import { AdminDataTable, ConfirmDialog, StatusBadge } from '../components';
import { useAiModels, useCreateAiModel, useDeleteAiModel, useUpdateAiModel, type AiModel } from '../api/ai-models';

// ---------------------------------------------------------------------------
// Option lists — curated from the domain enums (@arcaai/domains). The platform
// catalog only uses these task types; the remaining enum members are HF-task
// taxonomy not surfaced in the admin console.
// ---------------------------------------------------------------------------

const CATEGORY_OPTIONS = ['AUDIO', 'NLP', 'VISION', 'MULTI_MODAL', 'TABULAR'] as const;
const TASK_TYPE_OPTIONS = [
  'AUTOMATIC_SPEECH_RECOGNITION',
  'VOICE_ACTIVITY_DETECTION',
  'AUDIO_TO_AUDIO',
  'SUMMARIZATION',
  'TEXT_GENERATION',
  'GUARDRAIL',
] as const;
const MODEL_TYPE_OPTIONS = ['BASE_MODEL', 'FINETUNED_MODEL', 'QUANTIZED_MODEL'] as const;
const SOURCE_OPTIONS = ['HUGGINGFACE', 'GITHUB', 'MLFLOW', 'LOCAL'] as const;
const FORMAT_OPTIONS = ['SAFETENSOR', 'ONNX', 'NEMO', 'PYTORCH', 'CTRANSLATE2', 'FASTER_WHISPER', 'MLX', 'GGUF'] as const;

const SLUG_PATTERN = /[^a-z0-9]+/g;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(SLUG_PATTERN, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function parseTags(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

const aiModelSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  slug: z.string().min(2, 'Slug must be at least 2 characters').max(100).regex(SLUG_RE, 'Lowercase alphanumeric with hyphens'),
  description: z.string().max(1000).optional(),
  category: z.string().min(1, 'Category is required'),
  taskType: z.string().min(1, 'Task type is required'),
  modelType: z.string().min(1, 'Model type is required'),
  source: z.string().min(1, 'Source is required'),
  sourceUri: z.string().min(1, 'Source URI is required').max(500),
  sourceRevision: z.string().max(100).optional(),
  format: z.string().min(1, 'Format is required'),
  memorySizeMb: z.string().optional(),
  computeType: z.string().optional(),
  tags: z.string().optional(),
});

type AiModelFormValues = z.infer<typeof aiModelSchema>;

const EMPTY_FORM: AiModelFormValues = {
  name: '',
  slug: '',
  description: '',
  category: 'AUDIO',
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  modelType: 'BASE_MODEL',
  source: 'HUGGINGFACE',
  sourceUri: '',
  sourceRevision: '',
  format: 'SAFETENSOR',
  memorySizeMb: '',
  computeType: '',
  tags: '',
};

function toFormValues(model: AiModel): AiModelFormValues {
  return {
    name: model.name,
    slug: model.slug,
    description: model.description ?? '',
    category: model.category,
    taskType: model.taskType,
    modelType: model.modelType,
    source: model.source,
    sourceUri: model.sourceUri,
    sourceRevision: model.sourceRevision ?? '',
    format: model.format,
    memorySizeMb: model.memorySizeMb != null ? String(model.memorySizeMb) : '',
    computeType: model.computeType ?? '',
    tags: (model.tags ?? []).join(', '),
  };
}

function toMemorySize(raw?: string): number | undefined {
  if (!raw?.trim()) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export default function AiModelsPage() {
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());
  const tenantId = useAuthStore((s) => s.tenantId);
  const tenantName = useAuthStore((s) => s.tenantName);

  const needsTenant = isGlobalScope && !tenantId;
  const tenantLabel = tenantName || (tenantId ? `${tenantId.slice(0, 8)}\u2026` : '');

  const { data: models, isLoading, isRefetching, refetch } = useAiModels(tenantId);
  const deleteMutation = useDeleteAiModel(tenantId);

  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<AiModel | null>(null);
  const [deleting, setDeleting] = useState<AiModel | null>(null);

  const filtered = useMemo(() => {
    const all = models ?? [];
    if (!search) return all;
    const q = search.toLowerCase();
    return all.filter(
      (m) => m.name.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q) || (m.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [models, search]);

  const handleDelete = useCallback(async () => {
    if (!deleting) return;
    try {
      await deleteMutation.mutateAsync(deleting.id);
      toast.success('Model deleted');
      setDeleting(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete model');
    }
  }, [deleting, deleteMutation]);

  const columns = useMemo<ColumnDef<AiModel, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium">{row.original.name}</span>
            <span className="text-muted-foreground font-mono text-xs">{row.original.slug}</span>
          </div>
        ),
      },
      { accessorKey: 'category', header: 'Category', cell: ({ row }) => <Badge variant="outline">{row.original.category}</Badge> },
      { accessorKey: 'taskType', header: 'Task', cell: ({ row }) => <span className="text-sm">{row.original.taskType}</span> },
      { accessorKey: 'format', header: 'Format', cell: ({ row }) => <Badge variant="secondary">{row.original.format}</Badge> },
      { accessorKey: 'resourceStatus', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.resourceStatus} /> },
      {
        id: '_actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" data-testid={`edit-model-${row.original.id}`} onClick={() => setEditing(row.original)}>
              <Pencil data-icon="inline-start" />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              data-testid={`delete-model-${row.original.id}`}
              onClick={() => setDeleting(row.original)}
            >
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <Main>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">AI Models</h2>
          <p className="text-muted-foreground mt-1">Manage this tenant&apos;s clone of the model catalog.</p>
        </div>
        {!needsTenant && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Editing tenant:</span>
            <Badge variant="outline" className="gap-1.5" data-testid="ai-models-tenant">
              <Building2 className="size-3.5" />
              {tenantLabel || 'Current tenant'}
            </Badge>
          </div>
        )}
      </div>

      {needsTenant ? (
        <div
          className="bg-muted/20 text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center text-sm"
          data-testid="ai-models-select-tenant"
        >
          <Building2 className="size-8 opacity-60" />
          <p className="text-foreground text-sm font-medium">Select a tenant</p>
          <p>Pick a tenant from the switcher in the header to manage its AI model catalog.</p>
        </div>
      ) : (
        <AdminDataTable
          data={filtered}
          columns={columns}
          isLoading={isLoading}
          emptyMessage="No AI models yet for this tenant."
          toolbar={
            <div className="flex w-full items-center justify-between gap-3">
              <Input
                value={search}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
                placeholder="Search models..."
                aria-label="Search models"
                spellCheck={false}
                autoComplete="off"
                className="h-9 max-w-xs"
              />
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isRefetching} aria-label="Reload models">
                  <RefreshCw data-icon="inline-start" className={isRefetching ? 'animate-spin' : undefined} />
                  Reload
                </Button>
                <Button size="sm" data-testid="create-ai-model-btn" onClick={() => setShowCreate(true)}>
                  <Plus data-icon="inline-start" />
                  New model
                </Button>
              </div>
            </div>
          }
        />
      )}

      <AiModelFormDialog mode="create" open={showCreate} tenantId={tenantId} onOpenChange={(open) => setShowCreate(open)} />

      <AiModelFormDialog
        mode="edit"
        open={!!editing}
        tenantId={tenantId}
        model={editing ?? undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete AI model"
        description={`This moves "${deleting?.name ?? 'the model'}" to deleted (soft-delete); it can be restored by an administrator.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={deleteMutation.isPending}
      />
    </Main>
  );
}

interface FormDialogProps {
  mode: 'create' | 'edit';
  open: boolean;
  tenantId: string;
  model?: AiModel;
  onOpenChange: (open: boolean) => void;
}

function AiModelFormDialog({ mode, open, tenantId, model, onOpenChange }: FormDialogProps) {
  const createMutation = useCreateAiModel(tenantId);
  const updateMutation = useUpdateAiModel(tenantId);
  const [slugEdited, setSlugEdited] = useState(mode === 'edit');

  const form = useForm<AiModelFormValues>({
    resolver: zodResolver(aiModelSchema),
    defaultValues: EMPTY_FORM,
  });

  // Hydrate the form when the dialog opens (edit row or a fresh create).
  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && model) {
      form.reset(toFormValues(model));
      setSlugEdited(true);
    } else {
      form.reset(EMPTY_FORM);
      setSlugEdited(false);
    }
  }, [open, mode, model, form]);

  const onSubmit = useCallback(
    async (values: AiModelFormValues) => {
      try {
        if (mode === 'create') {
          await createMutation.mutateAsync({
            name: values.name.trim(),
            slug: values.slug.trim(),
            description: values.description || undefined,
            category: values.category,
            taskType: values.taskType,
            modelType: values.modelType,
            source: values.source,
            sourceUri: values.sourceUri.trim(),
            sourceRevision: values.sourceRevision || undefined,
            format: values.format,
            memorySizeMb: toMemorySize(values.memorySizeMb),
            computeType: values.computeType || undefined,
            tags: parseTags(values.tags),
          });
          toast.success('Model created');
        } else if (model) {
          const expectedVersion = typeof model.version === 'number' ? model.version : 1;
          await updateMutation.mutateAsync({
            id: model.id,
            name: values.name.trim(),
            slug: values.slug.trim(),
            description: values.description || undefined,
            category: values.category,
            taskType: values.taskType,
            modelType: values.modelType,
            source: values.source,
            sourceUri: values.sourceUri.trim(),
            sourceRevision: values.sourceRevision || undefined,
            format: values.format,
            memorySizeMb: toMemorySize(values.memorySizeMb),
            computeType: values.computeType || undefined,
            tags: parseTags(values.tags),
            expectedVersion,
            ifMatch: `"${expectedVersion}"`,
          });
          toast.success('Model updated');
        }
        onOpenChange(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save model');
      }
    },
    [mode, model, createMutation, updateMutation, onOpenChange],
  );

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl min-w-[40vw]" data-testid="ai-model-dialog">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Create AI model' : 'Edit AI model'}</DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Register a new model in this tenant catalog.'
              : 'Update this tenant model. Saving uses optimistic concurrency (If-Match).'}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex max-h-[65vh] flex-col gap-4 overflow-auto pr-1">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. Whisper Large V3"
                        {...field}
                        value={field.value ?? ''}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          field.onChange(e);
                          if (!slugEdited) form.setValue('slug', generateSlug(e.target.value), { shouldValidate: true });
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Slug</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. whisper-large-v3"
                        spellCheck={false}
                        {...field}
                        value={field.value ?? ''}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          setSlugEdited(true);
                          field.onChange(e);
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input placeholder="Short description" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <EnumSelectField control={form.control} name="category" label="Category" options={CATEGORY_OPTIONS} />
              <EnumSelectField control={form.control} name="taskType" label="Task type" options={TASK_TYPE_OPTIONS} />
              <EnumSelectField control={form.control} name="modelType" label="Model type" options={MODEL_TYPE_OPTIONS} />
              <EnumSelectField control={form.control} name="source" label="Source" options={SOURCE_OPTIONS} />
              <EnumSelectField control={form.control} name="format" label="Format" options={FORMAT_OPTIONS} />
              <FormField
                control={form.control}
                name="memorySizeMb"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Memory size (MB)</FormLabel>
                    <FormControl>
                      <Input type="number" min={1} placeholder="e.g. 4096" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="sourceUri"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Source URI</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. openai/whisper-large-v3" spellCheck={false} {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="sourceRevision"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Source revision</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. main" spellCheck={false} {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="computeType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Compute type</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. float16" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="tags"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tags</FormLabel>
                  <FormControl>
                    <Input placeholder="asr, multilingual, production" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="shrink-0">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button type="submit" data-testid="ai-model-submit" disabled={isPending}>
                {mode === 'create' ? 'Create model' : 'Save changes'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

interface EnumSelectFieldProps {
  // react-hook-form `control` is intentionally loosely typed here so this small
  // helper can serve every enum field without re-deriving the field union.
  control: ReturnType<typeof useForm<AiModelFormValues>>['control'];
  name: 'category' | 'taskType' | 'modelType' | 'source' | 'format';
  label: string;
  options: readonly string[];
}

function EnumSelectField({ control, name, label, options }: EnumSelectFieldProps) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select value={field.value || undefined} onValueChange={field.onChange}>
            <FormControl>
              <SelectTrigger data-testid={`select-${name}`}>
                <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
