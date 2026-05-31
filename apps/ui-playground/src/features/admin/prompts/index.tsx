import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@arcaai/ui/form';
import { Input } from '@arcaai/ui/input';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Separator } from '@arcaai/ui/separator';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';
import { Textarea } from '@arcaai/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/tooltip';
import { BarChart3, Building2, Calendar, Clock, Eye, FileText, GitBranch, History, Loader2, Plus, Tag, Trash2, Variable } from 'lucide-react';

import { Main } from '@/components/layout/main';
import { VersionDiffPanel } from '@/components/version-diff-panel';
import { cn } from '@/lib/utils';
import { zodResolver } from '@/lib/zod-resolver';
import { useAuthStore } from '@/store/auth-store';

import { MultiColumnLayout, type MultiColumnConfig, type MultiColumnContentConfig, type MultiColumnState } from '@arcaai/ui/multi-column-layout';
import {
  useCreatePrompt,
  useDeletePrompt,
  usePromptTemplate,
  usePromptTemplatesInfinite,
  usePromptUsageStats,
  usePromptVersions,
  useRefreshPromptDetails,
  useTogglePromptStatus,
  useUpdatePrompt,
  type PromptTemplate,
  type PromptTemplateCategory,
  type PromptTemplateStatus,
  type PromptVariable,
  type PromptVersion,
} from '../api/prompts';
import { useTenantsInfinite, type Tenant } from '../api/tenants';
import { ConfirmDialog, StatusBadge } from '../components';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const promptVariableSchema = z.object({
  name: z.string().min(1, 'Variable name is required'),
  type: z.enum(['string', 'number', 'boolean', 'json']),
  required: z.boolean(),
  default: z.string().optional(),
  description: z.string().optional(),
});

const createSchema = z.object({
  name: z.string().min(1, 'Name is required').max(128).default(''),
  description: z.string().max(512).default(''),
  category: z.enum(['SYSTEM', 'SUMMARY', 'DNA_ANALYSIS', 'CUSTOM']).default('CUSTOM'),
  status: z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT'),
  content: z.string().min(1, 'Prompt content is required').default(''),
  tags: z.string().default(''),
  variables: z.array(promptVariableSchema).default([]),
});

const editSchema = z.object({
  description: z.string().max(512).default(''),
  content: z.string().min(1, 'Prompt content is required'),
  status: z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT'),
  tags: z.string().default(''),
  changeReason: z.string().min(1, 'Change reason is required'),
  variables: z.array(promptVariableSchema).default([]),
});

type CreateFormValues = z.infer<typeof createSchema>;
type EditFormValues = z.infer<typeof editSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeFieldProps(field: any) {
  return {
    ref: field.ref,
    name: field.name,
    onBlur: field.onBlur,
    onChange: field.onChange,
    disabled: field.disabled,
    value: typeof field.value === 'string' ? field.value : '',
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<PromptTemplateCategory, string> = {
  SYSTEM: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  SUMMARY: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  PRE_SUMMARY: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-400',
  DNA_ANALYSIS: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  CUSTOM: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// CategoryBadge
// ---------------------------------------------------------------------------

function CategoryBadge({ category }: { category: PromptTemplateCategory }) {
  return (
    <Badge variant="outline" className={`text-xs ${CATEGORY_COLORS[category] ?? ''}`}>
      {category.replace('_', ' ')}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// InfoRow
// ---------------------------------------------------------------------------

function InfoRow({ label, value, icon, children }: { label: string; value?: string; icon?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      {icon && <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0">
        <p className="text-muted-foreground text-xs leading-none">{label}</p>
        <div className="mt-1">{children ?? <p className="text-sm font-medium leading-none">{value ?? '—'}</p>}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VariableEditor — inline variable list editor
// ---------------------------------------------------------------------------

function VariableEditor({ variables: rawVariables, onChange }: { variables: PromptVariable[]; onChange: (vars: PromptVariable[]) => void }) {
  const variables = Array.isArray(rawVariables) ? rawVariables : [];

  const addVariable = () => {
    onChange([...variables, { name: '', type: 'string', required: false, description: '' }]);
  };

  const removeVariable = (index: number) => {
    onChange(variables.filter((_, i) => i !== index));
  };

  const updateVariable = (index: number, field: string, value: unknown) => {
    const updated = variables.map((v, i) => (i === index ? { ...v, [field]: value } : v));
    onChange(updated);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Template Variables</p>
        <Button type="button" variant="outline" size="sm" onClick={addVariable}>
          <Plus className="mr-1 size-3" />
          Add Variable
        </Button>
      </div>
      {variables.length === 0 ? (
        <p className="text-muted-foreground text-xs">No variables defined. Variables use {'{{variable_name}}'} syntax in prompt content.</p>
      ) : (
        <div className="space-y-2">
          {variables.map((v, i) => (
            <div key={i} className="bg-muted/30 flex items-start gap-2 rounded-lg border p-3">
              <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
                <Input
                  placeholder="Name"
                  value={v.name}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateVariable(i, 'name', e.target.value)}
                  className="h-8 text-xs"
                />
                <Select value={v.type} onValueChange={(val: string) => updateVariable(i, 'type', val)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="string">String</SelectItem>
                    <SelectItem value="number">Number</SelectItem>
                    <SelectItem value="boolean">Boolean</SelectItem>
                    <SelectItem value="json">JSON</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  placeholder="Description"
                  value={v.description ?? ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateVariable(i, 'description', e.target.value)}
                  className="h-8 text-xs"
                />
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={v.required}
                      onChange={(e) => updateVariable(i, 'required', e.target.checked)}
                      className="size-3.5 rounded"
                    />
                    Required
                  </label>
                  <Button type="button" variant="ghost" size="icon" className="ml-auto size-6" onClick={() => removeVariable(i)}>
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CreatePromptDialog
// ---------------------------------------------------------------------------

const EMPTY_CREATE_VALUES: CreateFormValues = {
  name: '',
  description: '',
  category: 'CUSTOM',
  status: 'DRAFT',
  content: '',
  tags: '',
  variables: [],
};

function CreatePromptDialog({
  open,
  onOpenChange,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  onSubmit: (values: CreateFormValues) => void;
}) {
  const form = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: EMPTY_CREATE_VALUES,
  });

  useEffect(() => {
    if (open) {
      form.reset(EMPTY_CREATE_VALUES);
    }
  }, [open, form]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create Prompt Template</DialogTitle>
          <DialogDescription>Define a new prompt template for AI generation workflows.</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[65vh]">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pr-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="name"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  render={({ field }: { field: any }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Cardiology Summary v2" {...safeFieldProps(field)} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="category"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  render={({ field }: { field: any }) => (
                    <FormItem>
                      <FormLabel>Category</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="SYSTEM">System</SelectItem>
                          <SelectItem value="SUMMARY">Summary</SelectItem>
                          <SelectItem value="DNA_ANALYSIS">DNA Analysis</SelectItem>
                          <SelectItem value="CUSTOM">Custom</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="status"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  render={({ field }: { field: any }) => (
                    <FormItem>
                      <FormLabel>Status</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="DRAFT">Draft</SelectItem>
                          <SelectItem value="PUBLISHED">Published</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="tags"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  render={({ field }: { field: any }) => (
                    <FormItem>
                      <FormLabel>
                        Tags
                        <span className="text-muted-foreground ml-1 text-xs font-normal">(comma-separated)</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="cardiology, soap, v2" {...safeFieldProps(field)} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="description"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>
                      Description
                      <span className="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Textarea placeholder="Brief description of what this prompt does…" rows={2} {...safeFieldProps(field)} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="content"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Prompt Content</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="You are a medical documentation assistant…"
                        rows={8}
                        className="font-mono text-sm"
                        {...safeFieldProps(field)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="variables"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormControl>
                      <VariableEditor variables={field.value ?? []} onChange={field.onChange} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline" disabled={isPending}>
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={isPending}>
                  {isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Create Template
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// InlinePromptVersionDetail — editable form shown in the detail column
// ---------------------------------------------------------------------------

function InlinePromptVersionDetail({
  prompt,
  version,
  isPending,
  onSubmit,
}: {
  prompt: PromptTemplate;
  version: PromptVersion;
  isPending: boolean;
  onSubmit: (values: EditFormValues) => void;
}) {
  const form = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      description: '',
      content: '',
      status: 'DRAFT',
      tags: '',
      changeReason: '',
      variables: [],
    },
  });

  useEffect(() => {
    form.reset({
      description: prompt.description ?? '',
      content: version.content,
      status: (prompt.status ?? 'DRAFT') as PromptTemplateStatus,
      tags: tagsToString(prompt.tags),
      changeReason: '',
      variables: Array.isArray(version.variables) ? (version.variables as EditFormValues['variables']) : [],
    });
  }, [version.id, prompt.id, form]);

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex items-center gap-3">
        <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg">
          <GitBranch className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">Version {version.versionNumber}</h3>
            {version.versionNumber === prompt.currentVersionNumber && <Badge variant="secondary">Active</Badge>}
            {prompt.resourceStatus && prompt.resourceStatus.toUpperCase() === 'DISABLED' && (
              <Badge variant="outline" className="bg-red-500/15 text-red-700 dark:text-red-400 text-xs">
                DISABLED
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            {fmtDate(version.createdAt)}
            {version.changedBy && ` by ${version.changedBy}`}
          </p>
        </div>
      </div>

      <Separator />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FormField
            control={form.control}
            name="description"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            render={({ field }: { field: any }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Textarea placeholder="Brief description of what this prompt does…" rows={2} {...safeFieldProps(field)} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="status"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="DRAFT">Draft</SelectItem>
                      <SelectItem value="PUBLISHED">Published</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="tags"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>
                    Tags
                    <span className="text-muted-foreground ml-1 text-xs font-normal">(comma-separated)</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="cardiology, soap, v2" {...safeFieldProps(field)} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="content"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            render={({ field }: { field: any }) => (
              <FormItem>
                <FormLabel>Prompt Content</FormLabel>
                <FormControl>
                  <Textarea rows={12} className="font-mono text-sm" {...safeFieldProps(field)} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="variables"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            render={({ field }: { field: any }) => (
              <FormItem>
                <FormControl>
                  <VariableEditor variables={field.value ?? []} onChange={field.onChange} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <Separator />

          <FormField
            control={form.control}
            name="changeReason"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            render={({ field }: { field: any }) => (
              <FormItem>
                <FormLabel>
                  Change Reason
                  <span className="text-destructive ml-0.5">*</span>
                </FormLabel>
                <FormControl>
                  <Input placeholder="Describe what changed and why…" {...safeFieldProps(field)} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="flex justify-end">
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save as New Version
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PromptDetailDialog — shows full prompt info + usage stats
// ---------------------------------------------------------------------------

function PromptDetailDialog({
  open,
  onOpenChange,
  tenantId,
  promptId,
  inline,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  promptId: string | null;
  inline?: boolean;
}) {
  const { data: prompt, isLoading: promptLoading } = usePromptTemplate(tenantId, promptId ?? '', { enabled: !!promptId && open });
  const { data: usage, isLoading: usageLoading } = usePromptUsageStats(tenantId, promptId ?? '', { enabled: !!promptId && open });

  const content = promptLoading ? (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-4">
        <Skeleton className="size-12 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="h-48 w-full rounded-lg" />
    </div>
  ) : prompt ? (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex items-center gap-4">
        <div className="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-full">
          <FileText className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-lg font-semibold">{prompt.name}</h3>
            <CategoryBadge category={prompt.category} />
            <StatusBadge status={prompt.status ?? prompt.resourceStatus ?? 'DRAFT'} />
          </div>
          {prompt.description && <p className="text-muted-foreground mt-0.5 text-sm">{prompt.description}</p>}
        </div>
      </div>

      <div className="bg-muted/30 grid grid-cols-2 gap-4 rounded-lg border p-4">
        <InfoRow label="Version" icon={<GitBranch className="size-3.5" />} value={`v${prompt.currentVersionNumber}`} />
        <InfoRow label="Created" icon={<Calendar className="size-3.5" />} value={fmtDate(prompt.createdAt)} />
        <InfoRow label="Updated" icon={<Clock className="size-3.5" />} value={relativeTime(prompt.updatedAt)} />
        <InfoRow label="Usage" icon={<BarChart3 className="size-3.5" />}>
          {usageLoading ? <Skeleton className="h-4 w-16" /> : <p className="text-sm font-medium leading-none">{usage?.totalUsages ?? 0} uses</p>}
        </InfoRow>
      </div>

      {prompt.tags && prompt.tags.length > 0 && (
        <div>
          <p className="text-muted-foreground mb-2 flex items-center gap-1 text-xs font-medium">
            <Tag className="size-3" />
            Tags
          </p>
          <div className="flex flex-wrap gap-1">
            {prompt.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="px-1.5 py-0 text-[10px] leading-5">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {prompt.variables && prompt.variables.length > 0 && (
        <div>
          <p className="text-muted-foreground mb-2 flex items-center gap-1 text-xs font-medium">
            <Variable className="size-3" />
            Variables ({prompt.variables.length})
          </p>
          <div className="flex flex-col gap-1.5">
            {prompt.variables.map((v) => (
              <div key={v.name} className="bg-muted/30 flex items-center gap-3 rounded border px-3 py-2">
                <code className="text-xs font-medium">{`{{${v.name}}}`}</code>
                <Badge variant="outline" className="text-[10px]">
                  {v.type}
                </Badge>
                {v.required && (
                  <Badge variant="outline" className="text-[10px] text-red-600">
                    required
                  </Badge>
                )}
                {v.description && <span className="text-muted-foreground text-xs">{v.description}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="text-muted-foreground mb-2 text-xs font-medium">Prompt Content</p>
        <pre className="bg-muted/30 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border p-4 font-mono text-xs leading-relaxed">
          {prompt.content}
        </pre>
      </div>
    </div>
  ) : (
    <div className="flex flex-col items-center justify-center py-8">
      <FileText className="text-muted-foreground/50 mb-2 size-8" />
      <p className="text-muted-foreground text-sm">Prompt template not found.</p>
    </div>
  );

  if (inline) return content;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>Prompt Template Details</DialogTitle>
          <DialogDescription>Full details and usage statistics.</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh]">{content}</ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function PromptManagementPage() {
  // ---- Tenant context for super admins ------------------------------------

  const tenantKey = useAuthStore((s) => s.tenantKey);
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);
  const setTenantKey = useAuthStore((s) => s.setTenantKey);

  const [selectedTenantId, setSelectedTenantId] = useState(tenantKey || '');

  const {
    data: tenantsPages,
    hasNextPage: tenantsHasMore,
    fetchNextPage: fetchNextTenants,
    isFetchingNextPage: tenantsLoadingMore,
    isRefetching: tenantsRefreshing,
    refetch: refetchTenants,
  } = useTenantsInfinite(25, { enabled: isSuperAdmin() });
  const tenants = useMemo(() => tenantsPages?.pages.flatMap((p) => p.data) ?? [], [tenantsPages]);

  const effectiveTenantId = tenantKey || selectedTenantId;
  const hasTenantContext = !!effectiveTenantId;

  useEffect(() => {
    if (tenantKey && tenantKey !== selectedTenantId) {
      setSelectedTenantId(tenantKey);
    }
  }, [tenantKey, selectedTenantId]);

  const handleTenantSelect = useCallback(
    (tenantId: string) => {
      if (tenantId === effectiveTenantId) return;
      setSelectedTenantId(tenantId);
      setTenantKey(tenantId, tenants.find((t) => t.id === tenantId)?.name);
    },
    [effectiveTenantId, tenants, setTenantKey],
  );

  // ---- UI state -----------------------------------------------------------

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearchRaw] = useState('');
  const [categoryFilter, setCategoryFilterRaw] = useState('_all');
  const [statusFilter, setStatusFilterRaw] = useState('_all');
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedPrompt, setSelectedPrompt] = useState<PromptTemplate | null>(null);

  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = setTimeout(() => {
      setSearchRaw(searchInput.trim());
    }, 400);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchInput]);

  // ---- Data ---------------------------------------------------------------

  const infiniteParams = useMemo(() => {
    const p: Record<string, unknown> = { includeDisabled: true };
    if (categoryFilter !== '_all') p.category = categoryFilter;
    if (search) p.search = search;
    return p;
  }, [categoryFilter, search]);

  const {
    data: promptsPages,
    isLoading,
    hasNextPage: promptsHasMore,
    fetchNextPage: fetchNextPrompts,
    isFetchingNextPage: promptsLoadingMore,
    isRefetching: promptsRefreshing,
    refetch: refetchPrompts,
  } = usePromptTemplatesInfinite(
    effectiveTenantId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    infiniteParams as any,
  );

  const prompts = useMemo(() => promptsPages?.pages.flatMap((p) => p.data) ?? [], [promptsPages]);

  const filteredPrompts = useMemo(() => {
    let result = prompts;
    if (statusFilter !== '_all') {
      result = result.filter((p) => (p.status ?? 'DRAFT').toUpperCase() === statusFilter);
    }
    return result;
  }, [prompts, statusFilter]);

  // ---- Mutations ----------------------------------------------------------

  const createMutation = useCreatePrompt(effectiveTenantId);
  const updateMutation = useUpdatePrompt(effectiveTenantId);
  const deleteMutation = useDeletePrompt(effectiveTenantId);
  const toggleMutation = useTogglePromptStatus(effectiveTenantId);
  const refreshPromptDetails = useRefreshPromptDetails(effectiveTenantId);

  // ---- Handlers -----------------------------------------------------------

  const handleCreate = useCallback(
    (values: CreateFormValues) => {
      createMutation.mutate(
        {
          name: values.name,
          description: values.description || undefined,
          category: values.category as PromptTemplateCategory,
          status: values.status as PromptTemplateStatus | undefined,
          content: values.content,
          tags: parseTags(values.tags),
          variables: values.variables,
        },
        {
          onSuccess: () => {
            toast.success('Prompt template created');
            setCreateOpen(false);
          },
          onError: (err) => toast.error(`Failed to create prompt: ${err.message}`),
        },
      );
    },
    [createMutation],
  );

  const handleEdit = useCallback(
    (values: EditFormValues) => {
      if (!selectedPrompt) return;
      // TASK-302 Stream D Phase E.3 — `_version` is the CAS predicate.
      // Default to 1 only as a defensive fallback for pre-OCC rows the
      // backend hasn't stamped yet; once the migration is deployed the
      // server always returns a number.
      const expectedVersion =
        typeof (selectedPrompt as { version?: number }).version === 'number' ? (selectedPrompt as { version: number }).version : 1;
      updateMutation.mutate(
        {
          id: selectedPrompt.id,
          description: values.description || undefined,
          content: values.content,
          status: values.status as PromptTemplateStatus | undefined,
          tags: parseTags(values.tags),
          changeReason: values.changeReason,
          variables: values.variables,
          expectedVersion,
          ifMatch: `"${expectedVersion}"`,
        },
        {
          onSuccess: () => {
            toast.success('New version created');
            setSelectedVersionIds([]);
          },
          onError: (err) => toast.error(`Failed to create version: ${err.message}`),
        },
      );
    },
    [selectedPrompt, updateMutation],
  );

  const handleDelete = useCallback(() => {
    if (!selectedPrompt) return;
    deleteMutation.mutate(selectedPrompt.id, {
      onSuccess: () => {
        toast.success(`Prompt "${selectedPrompt.name}" deleted`);
        setDeleteOpen(false);
        setSelectedPrompt(null);
      },
      onError: (err) => toast.error(`Failed to delete prompt: ${err.message}`),
    });
  }, [selectedPrompt, deleteMutation]);

  const handleToggleStatus = useCallback(
    (prompt: PromptTemplate) => {
      const current = (prompt.resourceStatus ?? 'ENABLED').toUpperCase();
      const next = current === 'ENABLED' ? 'DISABLED' : 'ENABLED';
      // TASK-302 Stream D Phase E.3 — toggle still goes through the
      // `@RequiresIfMatch()` PATCH route, so supply the CAS predicate.
      const expectedVersion = typeof (prompt as { version?: number }).version === 'number' ? (prompt as { version: number }).version : 1;
      toggleMutation.mutate(
        { id: prompt.id, resourceStatus: next, expectedVersion, ifMatch: `"${expectedVersion}"` },
        {
          onSuccess: () => toast.success(`Prompt ${next === 'ENABLED' ? 'enabled' : 'disabled'}`),
          onError: (err) => toast.error(`Status update failed: ${err.message}`),
        },
      );
    },
    [toggleMutation],
  );

  // ---- Version state for 4th column ----------------------------------------

  const [selectedVersionIds, setSelectedVersionIds] = useState<string[]>([]);

  const {
    data: versions = [],
    isLoading: versionsLoading,
    isRefetching: versionsRefreshing,
    refetch: refetchVersions,
  } = usePromptVersions(effectiveTenantId, selectedPrompt?.id ?? '', { enabled: !!selectedPrompt });

  const sortedVersions = useMemo(() => [...versions].sort((a, b) => b.versionNumber - a.versionNumber), [versions]);

  const selectedVersions = useMemo(
    () => selectedVersionIds.map((id) => sortedVersions.find((v) => v.id === id)).filter((v): v is PromptVersion => Boolean(v)),
    [sortedVersions, selectedVersionIds],
  );

  const selectedVersion = selectedVersions.length === 1 ? selectedVersions[0]! : null;
  const selectedVersionId = selectedVersionIds[0] ?? null;

  const handleVersionSelect = useCallback((versionId: string) => {
    setSelectedVersionIds((prev) => {
      if (prev.includes(versionId)) return prev.filter((id) => id !== versionId);
      if (prev.length >= 2) return [prev[1]!, versionId];
      return [...prev, versionId];
    });
  }, []);

  useEffect(() => {
    // Tenant scope changed: reset dependent selection state.
    setSelectedPrompt(null);
    setSelectedVersionIds([]);
  }, [effectiveTenantId]);

  useEffect(() => {
    if (!selectedPrompt) return;

    const latestSelectedPrompt = filteredPrompts.find((p) => p.id === selectedPrompt.id);
    if (!latestSelectedPrompt) {
      setSelectedPrompt(null);
      setSelectedVersionIds([]);
      return;
    }

    if (
      latestSelectedPrompt.id !== selectedPrompt.id ||
      latestSelectedPrompt.updatedAt !== selectedPrompt.updatedAt ||
      latestSelectedPrompt.currentVersionNumber !== selectedPrompt.currentVersionNumber ||
      latestSelectedPrompt.resourceStatus !== selectedPrompt.resourceStatus
    ) {
      setSelectedPrompt(latestSelectedPrompt);
    }
  }, [filteredPrompts, selectedPrompt]);

  useEffect(() => {
    if (sortedVersions.length > 0 && selectedVersionIds.length === 0) {
      setSelectedVersionIds([sortedVersions[0]!.id]);
    }
  }, [sortedVersions, selectedVersionIds.length]);

  useEffect(() => {
    setSelectedVersionIds((prev) => {
      const next = prev.filter((id) => sortedVersions.some((v) => v.id === id));
      if (next.length === prev.length && next.every((id, index) => id === prev[index])) {
        return prev;
      }
      return next;
    });
  }, [sortedVersions]);

  const refreshVersions = useCallback(() => {
    if (!selectedPrompt) return;

    void refreshPromptDetails(selectedPrompt.id);
    void refetchVersions();
  }, [refetchVersions, refreshPromptDetails, selectedPrompt]);

  // ---- Multi-column layout ------------------------------------------------

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
    keyExtractor: (t) => t.id,
    renderItem: (t) => (
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

  const promptsColumn: MultiColumnConfig<PromptTemplate> = {
    id: 'prompts',
    title: 'Prompt Templates',
    showItemCount: true,
    width: '240px',
    skeletonCount: 5,
    skeletonHeight: 'h-16',
    estimateItemSize: 72,
    headerActions: (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <Input
            placeholder="Search prompts…"
            value={searchInput}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchInput(e.target.value)}
            className="h-7 flex-1 text-xs"
          />
          <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setCreateOpen(true)} disabled={!hasTenantContext}>
            <Plus className="size-3.5" />
            New
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <Select value={categoryFilter} onValueChange={setCategoryFilterRaw}>
            <SelectTrigger className="h-7 flex-1 text-xs">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all">All Categories</SelectItem>
              <SelectItem value="SYSTEM">System</SelectItem>
              <SelectItem value="SUMMARY">Summary</SelectItem>
              <SelectItem value="DNA_ANALYSIS">DNA Analysis</SelectItem>
              <SelectItem value="CUSTOM">Custom</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilterRaw}>
            <SelectTrigger className="h-7 flex-1 text-xs">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all">All Statuses</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
              <SelectItem value="PUBLISHED">Published</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    ),
    emptyIcon: <FileText className="size-5" />,
    emptyTitle: !hasTenantContext ? 'No tenant selected' : 'No prompt templates',
    emptyDescription: !hasTenantContext ? 'Select a tenant to view prompts.' : 'Create a prompt template to get started.',
    onRefresh: hasTenantContext
      ? () => {
          void refetchPrompts();
        }
      : undefined,
    isRefreshing: promptsRefreshing,
    keyExtractor: (p) => p.id,
    renderItem: (p) => {
      const isEnabled = (p.resourceStatus ?? 'ENABLED').toUpperCase() === 'ENABLED';
      return (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className={cn('truncate text-sm font-medium', !isEnabled && 'text-muted-foreground line-through')}>{p.name}</p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <CategoryBadge category={p.category} />
              <StatusBadge status={p.status ?? 'DRAFT'} />
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <GitBranch className="size-3" />v{p.currentVersionNumber}
              </span>
            </div>
          </div>
          <Switch
            checked={isEnabled}
            onCheckedChange={() => handleToggleStatus(p)}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            disabled={toggleMutation.isPending}
            size="sm"
          />
        </div>
      );
    },
  };

  const promptsState: MultiColumnState<PromptTemplate> = {
    data: filteredPrompts,
    isLoading,
    enabled: hasTenantContext,
    selectedId: selectedPrompt?.id ?? null,
    onSelect: (id) => {
      if (id === selectedPrompt?.id) return;
      const p = filteredPrompts.find((x) => x.id === id) ?? null;
      setSelectedPrompt(p);
      setSelectedVersionIds([]);
    },
    hasMore: !!promptsHasMore,
    onLoadMore: () => fetchNextPrompts(),
    isLoadingMore: promptsLoadingMore,
  };

  const versionsColumn: MultiColumnConfig<PromptVersion> = {
    id: 'versions',
    title: 'Versions',
    subtitle: selectedPrompt?.name,
    showItemCount: true,
    width: '180px',
    skeletonCount: 3,
    skeletonHeight: 'h-14',
    estimateItemSize: 64,
    headerActions: selectedPrompt ? (
      <div className="flex items-center gap-2">
        <Switch
          checked={(selectedPrompt.resourceStatus ?? 'ENABLED').toUpperCase() === 'ENABLED'}
          onCheckedChange={() => handleToggleStatus(selectedPrompt)}
          disabled={toggleMutation.isPending}
          size="sm"
        />
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="text-destructive size-7" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete Prompt</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    ) : undefined,
    emptyIcon: <History className="size-5" />,
    emptyTitle: !selectedPrompt ? 'No prompt selected' : 'No versions',
    emptyDescription: !selectedPrompt ? 'Select a prompt to view versions.' : undefined,
    onRefresh: selectedPrompt
      ? () => {
          refreshVersions();
        }
      : undefined,
    isRefreshing: versionsRefreshing,
    keyExtractor: (v) => v.id,
    renderItem: (v) => (
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">v{v.versionNumber}</span>
            {v.versionNumber === selectedPrompt?.currentVersionNumber && (
              <Badge variant="secondary" className="text-[10px]">
                active
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground truncate text-xs">{v.changeReason || relativeTime(v.createdAt)}</p>
        </div>
      </div>
    ),
  };

  const versionsState: MultiColumnState<PromptVersion> = {
    data: sortedVersions,
    isLoading: versionsLoading,
    enabled: !!selectedPrompt,
    selectedId: selectedVersionIds[0] ?? null,
    selectedIds: selectedVersionIds,
    onSelect: handleVersionSelect,
  };

  const detailColumn: MultiColumnContentConfig = {
    type: 'content',
    id: 'detail',
    title: selectedVersions.length === 2 ? 'Version Diff' : 'Version Detail',
    subtitle:
      selectedVersions.length === 2
        ? `v${selectedVersions[0]!.versionNumber} vs v${selectedVersions[1]!.versionNumber}`
        : selectedVersion
          ? `v${selectedVersion.versionNumber}`
          : selectedPrompt
            ? selectedPrompt.name
            : 'Select a version',
    width: '1fr',
    emptyIcon: <Eye className="size-5" />,
    emptyTitle: !selectedPrompt ? 'No prompt selected' : selectedVersionIds.length === 0 ? 'No version selected' : 'Version not found',
    emptyDescription: !selectedPrompt ? 'Select a prompt template from the list.' : 'Select one version for detail or two for diff.',
    onRefresh: selectedPrompt
      ? () => {
          refreshVersions();
        }
      : undefined,
    isRefreshing: promptsRefreshing || versionsRefreshing,
    renderContent: () => {
      if (selectedVersions.length === 2 && selectedPrompt) {
        const [left, right] = [...selectedVersions].sort((a, b) => a.versionNumber - b.versionNumber);
        return (
          <VersionDiffPanel
            left={{ versionNumber: left.versionNumber, date: left.createdAt, changeReason: left.changeReason }}
            right={{ versionNumber: right.versionNumber, date: right.createdAt, changeReason: right.changeReason }}
            sections={[
              {
                label: 'Prompt Content',
                oldText: left.content || '',
                newText: right.content || '',
              },
            ]}
            contentClassName="font-mono text-sm"
          />
        );
      }

      if (selectedVersionId && selectedVersion && selectedPrompt) {
        return (
          <InlinePromptVersionDetail prompt={selectedPrompt} version={selectedVersion} isPending={updateMutation.isPending} onSubmit={handleEdit} />
        );
      }

      if (selectedPrompt && !selectedVersionId) {
        return <PromptDetailDialog open onOpenChange={() => {}} tenantId={effectiveTenantId} promptId={selectedPrompt.id} inline />;
      }

      return null;
    },
  };

  const detailState: MultiColumnState<never> = {
    data: [],
    isLoading: false,
    enabled: !!selectedPrompt,
    selectedId: null,
    onSelect: () => {},
  };

  // ---- Render -------------------------------------------------------------

  return (
    <Main>
      <div className="mb-4">
        <h2 className="text-2xl font-bold tracking-tight">Prompt Templates</h2>
        <p className="text-muted-foreground mt-1">Create, edit, and manage prompt templates used for AI generation across departments.</p>
      </div>

      <MultiColumnLayout
        columns={[...(isSuperAdmin() ? [tenantsColumn] : []), promptsColumn, versionsColumn, detailColumn]}
        columnStates={[...(isSuperAdmin() ? [tenantsState] : []), promptsState, versionsState, detailState]}
        height="calc(100vh - 12rem)"
      />

      <CreatePromptDialog open={createOpen} onOpenChange={setCreateOpen} isPending={createMutation.isPending} onSubmit={handleCreate} />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(v) => {
          setDeleteOpen(v);
          if (!v) setSelectedPrompt(null);
        }}
        title="Delete Prompt Template"
        description={`Are you sure you want to delete "${selectedPrompt?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={deleteMutation.isPending}
      />
    </Main>
  );
}
