/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@arcaai/ui/form';
import { Input } from '@arcaai/ui/input';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Separator } from '@arcaai/ui/separator';
import { Textarea } from '@arcaai/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/tooltip';
import { Building2, Calendar, Clock, Copy, Loader2, Pencil, Plus, Tag, Trash2, Workflow } from 'lucide-react';

import { configToYaml, DEFAULT_CONFIG, PipelineConfigEditor } from './pipeline-config-editor';

import { Main } from '@/components/layout/main';
import { zodResolver } from '@/lib/zod-resolver';
import { useAuthStore } from '@/store/auth-store';

import { MultiColumnLayout, type MultiColumnConfig, type MultiColumnContentConfig, type MultiColumnState } from '@arcaai/ui/multi-column-layout';
import {
  useAudioPipelines,
  useCreateAudioPipeline,
  useDeleteAudioPipeline,
  useUpdateAudioPipeline,
  useValidateAudioPipelineYaml,
  type AudioPipeline,
} from '../api/audio-pipelines';
import { useTenantsInfinite, type Tenant } from '../api/tenants';
import { ConfirmDialog, StatusBadge } from '../components';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const slugPattern = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

const pipelineFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  slug: z.string().min(2, 'Slug must be at least 2 characters').max(100).regex(slugPattern, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().max(1000).default(''),
  configYaml: z.string().min(1, 'Pipeline YAML configuration is required'),
  tags: z.string().default(''),
});

type PipelineFormValues = z.infer<typeof pipelineFormSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function relativeTime(dateStr?: string | null): string {
  if (!dateStr) return '—';
  const ms = Date.now() - new Date(dateStr).getTime();
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (day > 30) {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  if (day >= 1) return rtf.format(-day, 'day');
  if (hr >= 1) return rtf.format(-hr, 'hour');
  if (min >= 1) return rtf.format(-min, 'minute');
  return rtf.format(-sec, 'second');
}

function fmtDate(dateStr?: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function parseTags(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function tagsToString(tags?: string[]): string {
  return tags?.join(', ') ?? '';
}

function extractModelsFromYaml(yaml: string): { asr?: string; vad?: string; denoise?: string } {
  const result: { asr?: string; vad?: string; denoise?: string } = {};

  // Extract ASR model
  const asrMatch = yaml.match(/asr:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const asrHfMatch = yaml.match(/asr:[\s\S]*?hf_model_id:\s*(?:"([^"]+)"|'([^']+)')/);
  result.asr = asrHfMatch?.[1] ?? asrHfMatch?.[2] ?? asrMatch?.[1] ?? asrMatch?.[2] ?? asrMatch?.[3];

  // Extract VAD model
  const vadHfMatch = yaml.match(/vad:[\s\S]*?hf_model_id:\s*(?:"([^"]+)"|'([^']+)')/);
  const vadMatch = yaml.match(/vad:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  result.vad = vadHfMatch?.[1] ?? vadHfMatch?.[2] ?? vadMatch?.[1] ?? vadMatch?.[2];

  // Extract denoise model
  const denoiseHfMatch = yaml.match(/denoise:[\s\S]*?hf_model_id:\s*(?:"([^"]+)"|'([^']+)')/);
  const denoiseMatch = yaml.match(/denoise:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  result.denoise = denoiseHfMatch?.[1] ?? denoiseHfMatch?.[2] ?? denoiseMatch?.[1] ?? denoiseMatch?.[2];

  return result;
}

// ---------------------------------------------------------------------------
// InfoRow
// ---------------------------------------------------------------------------

function InfoRow({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="truncate text-sm">{value || '—'}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Pipeline Dialog
// ---------------------------------------------------------------------------

function CreatePipelineDialog({ open, onOpenChange, tenantId }: { open: boolean; onOpenChange: (open: boolean) => void; tenantId: string }) {
  const createMutation = useCreateAudioPipeline(tenantId);
  const validateYaml = useValidateAudioPipelineYaml(tenantId);

  const form = useForm<PipelineFormValues>({
    resolver: zodResolver<PipelineFormValues>(pipelineFormSchema),
    defaultValues: {
      name: '',
      slug: '',
      description: '',
      configYaml: DEFAULT_YAML_TEMPLATE,
      tags: '',
    },
  });

  const watchName = form.watch('name');
  useEffect(() => {
    if (watchName && !form.getFieldState('slug').isDirty) {
      form.setValue('slug', generateSlug(watchName));
    }
  }, [watchName, form]);

  const handleInvalidSubmit = useCallback(() => {
    toast.error('Cannot create pipeline. Please fix the highlighted fields.');
  }, []);

  const onSubmit = useCallback(
    async (values: PipelineFormValues) => {
      try {
        // Validate YAML first
        const validation = await validateYaml.mutateAsync(values.configYaml);
        if (!validation.valid) {
          form.setError('configYaml', {
            message: `Invalid YAML: ${validation.errors?.join(', ')}`,
          });
          toast.error('Cannot create pipeline. YAML configuration is invalid.');
          return;
        }

        await createMutation.mutateAsync({
          name: values.name,
          slug: values.slug,
          description: values.description || undefined,
          configYaml: values.configYaml,
          tags: parseTags(values.tags),
        });
        toast.success('Pipeline created successfully');
        form.reset();
        onOpenChange(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to create pipeline');
      }
    },
    [createMutation, validateYaml, form, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl min-w-[40vw] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Create Audio Pipeline</DialogTitle>
          <DialogDescription>Define a new Audio pipeline configuration with model references and processing parameters.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit, handleInvalidSubmit)} className="flex flex-col gap-4">
            <ScrollArea className="max-h-[60vh] pr-4">
              <div className="flex flex-col gap-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }: { field: any }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g., Production Pipeline (Whisper Large V3)" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="slug"
                  render={({ field }: { field: any }) => (
                    <FormItem>
                      <FormLabel>Slug</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g., production-whisper-large-v3" spellCheck={false} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }: { field: any }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Describe the pipeline purpose and configuration..." rows={2} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="configYaml"
                  render={({ field }: { field: any }) => (
                    <FormItem>
                      <FormLabel>Pipeline Configuration</FormLabel>
                      <FormControl>
                        <PipelineConfigEditor value={field.value} onChange={field.onChange} rows={14} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="tags"
                  render={({ field }: { field: any }) => (
                    <FormItem>
                      <FormLabel>Tags</FormLabel>
                      <FormControl>
                        <Input placeholder="production, high-quality, recommended" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </ScrollArea>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={createMutation.isPending || validateYaml.isPending}>
                {(createMutation.isPending || validateYaml.isPending) && <Loader2 data-icon="inline-start" className="animate-spin" />}
                Create Pipeline
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Pipeline Detail (Inline Edit)
// ---------------------------------------------------------------------------

function PipelineDetail({ pipeline, onDeleted, tenantId }: { pipeline: AudioPipeline; onDeleted: () => void; tenantId: string }) {
  const updateMutation = useUpdateAudioPipeline(tenantId);
  const deleteMutation = useDeleteAudioPipeline(tenantId);
  const validateYaml = useValidateAudioPipelineYaml(tenantId);

  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const prevPipelineIdRef = useRef(pipeline.id);

  const form = useForm<PipelineFormValues>({
    resolver: zodResolver<PipelineFormValues>(pipelineFormSchema),
    defaultValues: {
      name: pipeline.name,
      slug: pipeline.slug,
      description: pipeline.description ?? '',
      configYaml: pipeline.configYaml,
      tags: tagsToString(pipeline.tags),
    },
  });

  // Reset form only when switching to a different pipeline.
  // Avoid resetting on background refetches for the same id.
  useEffect(() => {
    if (prevPipelineIdRef.current === pipeline.id) {
      return;
    }

    prevPipelineIdRef.current = pipeline.id;
    form.reset({
      name: pipeline.name,
      slug: pipeline.slug,
      description: pipeline.description ?? '',
      configYaml: pipeline.configYaml,
      tags: tagsToString(pipeline.tags),
    });
    setIsEditing(false);
  }, [pipeline, form]);

  const handleInvalidSubmit = useCallback(() => {
    toast.error('Cannot save changes. Please fix the highlighted fields.');
  }, []);

  const onSubmit = useCallback(
    async (values: PipelineFormValues) => {
      try {
        // Validate YAML first
        const validation = await validateYaml.mutateAsync(values.configYaml);
        if (!validation.valid) {
          form.setError('configYaml', {
            message: `Invalid YAML: ${validation.errors?.join(', ')}`,
          });
          toast.error('Cannot save changes. YAML configuration is invalid.');
          return;
        }

        await updateMutation.mutateAsync({
          id: pipeline.id,
          name: values.name,
          slug: values.slug,
          description: values.description || undefined,
          configYaml: values.configYaml,
          tags: parseTags(values.tags),
        });
        toast.success('Pipeline updated successfully');
        setIsEditing(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update pipeline');
      }
    },
    [updateMutation, validateYaml, pipeline.id, form],
  );

  const handleDelete = useCallback(async () => {
    try {
      await deleteMutation.mutateAsync(pipeline.id);
      toast.success('Pipeline deleted');
      setShowDeleteConfirm(false);
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete pipeline');
    }
  }, [deleteMutation, pipeline.id, onDeleted]);

  const handleCopyYaml = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(pipeline.configYaml);
      toast.success('YAML copied to clipboard');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to copy YAML');
    }
  }, [pipeline.configYaml]);

  if (isEditing) {
    return (
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit, handleInvalidSubmit)} className="flex h-full flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="slug"
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Slug</FormLabel>
                    <FormControl>
                      <Input spellCheck={false} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea rows={2} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="configYaml"
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Pipeline Configuration</FormLabel>
                    <FormControl>
                      <PipelineConfigEditor value={field.value} onChange={field.onChange} rows={18} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="tags"
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Tags</FormLabel>
                    <FormControl>
                      <Input placeholder="production, high-quality, recommended" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </ScrollArea>
          <div className="bg-background flex justify-end gap-2 border-t p-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                form.reset();
                setIsEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={updateMutation.isPending || validateYaml.isPending}>
              {(updateMutation.isPending || validateYaml.isPending) && <Loader2 data-icon="inline-start" className="animate-spin" />}
              Save Changes
            </Button>
          </div>
        </form>
      </Form>
    );
  }

  return (
    <>
      <ScrollArea className="h-full">
        <div className="flex flex-col gap-4 p-4">
          {/* Action bar: status/tags on left, actions on right */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={pipeline.resourceStatus} />
              {pipeline.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  <Tag className="mr-1 size-3" />
                  {tag}
                </Badge>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setIsEditing(true)}>
                <Pencil className="size-3" />
                Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive h-7 gap-1.5 text-xs"
                onClick={() => setShowDeleteConfirm(true)}
              >
                <Trash2 className="size-3" />
                Delete
              </Button>
            </div>
          </div>

          {/* Description */}
          {pipeline.description && <p className="text-muted-foreground text-sm">{pipeline.description}</p>}

          {/* Metadata */}
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <InfoRow icon={Calendar} label="Created" value={fmtDate(pipeline.createdAt)} />
            <InfoRow icon={Clock} label="Updated" value={relativeTime(pipeline.updatedAt)} />
          </div>

          <Separator />

          {/* Pipeline Configuration — read-only form by default */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold">Pipeline Configuration</h4>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-7" onClick={handleCopyYaml} aria-label="Copy pipeline YAML">
                      <Copy data-icon="inline-start" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Copy YAML</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <PipelineConfigEditor value={pipeline.configYaml} readOnly />
          </div>
        </div>
      </ScrollArea>

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Pipeline"
        description={`Are you sure you want to delete "${pipeline.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Default YAML Template
// ---------------------------------------------------------------------------

const DEFAULT_YAML_TEMPLATE = configToYaml(DEFAULT_CONFIG);

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function AudioPipelineManagementPage() {
  const tenantId = useAuthStore((s) => s.tenantId);
  const tenantKey = useAuthStore((s) => s.tenantKey);
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);
  const setTenantKey = useAuthStore((s) => s.setTenantKey);

  const [selectedTenantId, setSelectedTenantId] = useState(tenantKey || '');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const {
    data: tenantsPages,
    hasNextPage: tenantsHasMore,
    fetchNextPage: fetchNextTenants,
    isFetchingNextPage: tenantsLoadingMore,
    isRefetching: tenantsRefreshing,
    refetch: refetchTenants,
  } = useTenantsInfinite(25, { enabled: isSuperAdmin() });

  const tenants = useMemo(() => tenantsPages?.pages.flatMap((p) => p.data) ?? [], [tenantsPages]);

  const effectiveTenantId = tenantId || tenantKey || selectedTenantId;
  const hasTenantContext = !!effectiveTenantId;

  useEffect(() => {
    const preferredTenantId = tenantId || tenantKey;
    if (preferredTenantId && preferredTenantId !== selectedTenantId) {
      setSelectedTenantId(preferredTenantId);
    }
  }, [tenantId, tenantKey, selectedTenantId]);

  const handleTenantSelect = useCallback(
    (tenantId: string) => {
      if (tenantId === effectiveTenantId) return;
      setSelectedTenantId(tenantId);
      setTenantKey(tenantId, tenants.find((t) => t.id === tenantId)?.name);
    },
    [effectiveTenantId, setTenantKey, tenants],
  );

  const { data: pipelines, isLoading, isRefetching, refetch } = useAudioPipelines(effectiveTenantId);

  const filteredPipelines = useMemo(() => {
    if (!pipelines) return [];
    if (!search) return pipelines;
    const q = search.toLowerCase();
    return pipelines.filter(
      (p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [pipelines, search]);

  const selectedPipeline = useMemo(() => filteredPipelines.find((p) => p.id === selectedId), [filteredPipelines, selectedId]);

  // Clear selection if filtered out
  useEffect(() => {
    if (selectedId && !filteredPipelines.some((p) => p.id === selectedId)) {
      setSelectedId('');
    }
  }, [filteredPipelines, selectedId]);

  useEffect(() => {
    setSelectedId('');
  }, [effectiveTenantId]);

  const handlePipelineDeleted = useCallback(() => {
    setSelectedId('');
  }, []);

  const tenantsColumn: MultiColumnConfig<Tenant> = {
    id: 'tenants',
    title: 'Tenants',
    showItemCount: true,
    width: '180px',
    skeletonCount: 5,
    skeletonHeight: 'h-12',
    estimateItemSize: 56,
    emptyIcon: <Building2 className="size-5" />,
    emptyTitle: 'No tenants available',
    onRefresh: () => {
      void refetchTenants();
    },
    isRefreshing: tenantsRefreshing,
    keyExtractor: (t: Tenant) => t.id,
    renderItem: (t: Tenant) => (
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{t.name}</p>
          <p className="text-muted-foreground truncate text-xs">{t.key}</p>
        </div>
      </div>
    ),
  };

  const tenantsState: MultiColumnState<Tenant> = {
    data: tenants,
    isLoading: !tenants.length && isSuperAdmin(),
    selectedId: effectiveTenantId || null,
    onSelect: handleTenantSelect,
    hasMore: !!tenantsHasMore,
    onLoadMore: () => fetchNextTenants(),
    isLoadingMore: tenantsLoadingMore,
  };

  // Column: Pipeline List
  const pipelineColumn: MultiColumnConfig<AudioPipeline> = {
    id: 'audio-pipelines',
    title: 'Audio Pipelines',
    subtitle: 'Pipeline configurations',
    width: '340px',
    showItemCount: true,
    keyExtractor: (p: AudioPipeline) => p.id,
    estimateItemSize: 80,
    headerControls: (
      <div className="flex items-center gap-2">
        <Input
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
          placeholder="Search pipelines..."
          aria-label="Search Audio pipelines"
          spellCheck={false}
          autoComplete="off"
          className="h-8"
        />
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="size-8 shrink-0"
                onClick={() => setShowCreate(true)}
                disabled={!hasTenantContext}
                aria-label="Create pipeline"
              >
                <Plus data-icon="inline-start" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Create pipeline</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    ),
    renderItem: (pipeline: AudioPipeline) => {
      const models = extractModelsFromYaml(pipeline.configYaml);
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium">{pipeline.name}</p>
          </div>
          <p className="text-muted-foreground truncate font-mono text-xs">{pipeline.slug}</p>
          <div className="flex flex-wrap items-center gap-1">
            {models.asr && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                ASR: {models.asr.split('/').pop()}
              </Badge>
            )}
            {models.vad && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                VAD
              </Badge>
            )}
            {models.denoise && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                Denoise
              </Badge>
            )}
          </div>
        </div>
      );
    },
    onRefresh: () => {
      if (hasTenantContext) {
        void refetch();
      }
    },
    isRefreshing: isRefetching,
    emptyIcon: <Workflow className="text-muted-foreground size-10" />,
    emptyTitle: !hasTenantContext ? 'No tenant selected' : 'No pipelines',
    emptyDescription: !hasTenantContext ? 'Select a tenant to view pipelines.' : 'Create your first Audio pipeline to get started.',
  };

  const pipelineState: MultiColumnState<AudioPipeline> = {
    data: filteredPipelines,
    isLoading: hasTenantContext ? isLoading : false,
    selectedId,
    onSelect: (id: string) => setSelectedId(id),
  };

  // Column: Pipeline Detail
  const detailColumn: MultiColumnContentConfig = {
    type: 'content',
    id: 'audio-pipeline-detail',
    title: selectedPipeline?.name ?? 'Pipeline Details',
    subtitle: selectedPipeline?.slug,
    width: '1fr',
    renderContent: () => {
      if (!selectedPipeline) {
        return (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2">
            <Workflow className="size-10 opacity-50" />
            <p className="text-sm">Select a pipeline to view its configuration</p>
          </div>
        );
      }
      return (
        <div className="h-full overflow-hidden">
          <PipelineDetail pipeline={selectedPipeline} onDeleted={handlePipelineDeleted} tenantId={effectiveTenantId} />
        </div>
      );
    },
  };

  const detailState: MultiColumnState<never> = {
    data: [],
    isLoading: false,
    selectedId: null,
    onSelect: () => {},
    enabled: hasTenantContext && !!selectedId,
  };

  const columns = isSuperAdmin() ? [tenantsColumn, pipelineColumn, detailColumn] : [pipelineColumn, detailColumn];
  const columnStates = isSuperAdmin() ? [tenantsState, pipelineState, detailState] : [pipelineState, detailState];

  return (
    <Main>
      <div className="mb-4">
        <h2 className="text-2xl font-bold tracking-tight">Audio Pipeline Management</h2>
        <p className="text-muted-foreground mt-1">Configure Audio pipelines for speech-to-text processing.</p>
      </div>
      <MultiColumnLayout columns={columns} columnStates={columnStates} height="calc(100vh - 12rem)" />
      {hasTenantContext && <CreatePipelineDialog open={showCreate} onOpenChange={setShowCreate} tenantId={effectiveTenantId} />}
    </Main>
  );
}
