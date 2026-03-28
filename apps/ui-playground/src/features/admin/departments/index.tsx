import { zodResolver } from '@/lib/zod-resolver';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@arcaai/ui/form';
import { Input } from '@arcaai/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Separator } from '@arcaai/ui/separator';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Textarea } from '@arcaai/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/tooltip';
import { Building2, Check, FolderTree, Loader2, Plus, Trash2, X } from 'lucide-react';

import { Main } from '@/components/layout/main';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';

import { MultiColumnLayout, type MultiColumnConfig, type MultiColumnContentConfig, type MultiColumnState } from '@arcaai/ui/multi-column-layout';
import {
  useCreateTenantDepartment,
  useDeleteTenantDepartment,
  useRefreshTenantDepartmentDetail,
  useTenantDepartment,
  useTenantDepartments,
  useUpdateTenantDepartment,
  useUpdateTenantDepartmentPromptConfig,
  type Department,
} from '../api/departments';
import { usePromptTemplates, type PromptTemplate } from '../api/prompts';
import { useTenantsInfinite, type Tenant } from '../api/tenants';
import { ConfirmDialog, StatusBadge } from '../components';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const departmentSchema = z.object({
  code: z.string().max(20).optional().or(z.literal('')),
  name: z.string().min(1, 'Department name is required').max(100),
  description: z.string().max(500).optional().or(z.literal('')),
  parentDepartmentId: z.string().optional().or(z.literal('')),
  defaultSummaryTemplate: z.string().optional().or(z.literal('')),
});

const promptConfigSchema = z.object({
  preSummaryPromptId: z.string().optional().or(z.literal('')),
  newPatientPromptId: z.string().optional().or(z.literal('')),
  revisitPromptId: z.string().optional().or(z.literal('')),
});

type DepartmentFormValues = z.infer<typeof departmentSchema>;
type PromptConfigValues = z.infer<typeof promptConfigSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = [
  { value: '_all', label: 'All Statuses' },
  { value: 'ENABLED', label: 'Enabled' },
  { value: 'DISABLED', label: 'Disabled' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PromptBadge — shows configured/missing state for a prompt field
// ---------------------------------------------------------------------------

function PromptBadge({ label, promptId, promptName }: { label: string; promptId?: string; promptName?: string }) {
  const configured = !!promptId;
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={configured ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'}
          >
            {configured ? <Check className="mr-1 size-3" /> : <X className="mr-1 size-3" />}
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{configured ? `Assigned: ${promptName || 'Unknown prompt'}` : `No ${label.toLowerCase()} prompt assigned`}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// DepartmentFormDialog — Create / Edit (wider, better UX)
// ---------------------------------------------------------------------------

function DepartmentFormDialog({
  open,
  onOpenChange,
  department,
  departments,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  department?: Department | null;
  departments: Department[];
  isPending: boolean;
  onSubmit: (values: DepartmentFormValues) => void;
}) {
  const isEdit = !!department;

  const form = useForm<DepartmentFormValues>({
    resolver: zodResolver(departmentSchema),
    defaultValues: {
      code: '',
      name: '',
      description: '',
      parentDepartmentId: '',
      defaultSummaryTemplate: '',
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        code: department?.code ?? '',
        name: department?.name ?? '',
        description: department?.description ?? '',
        parentDepartmentId: department?.parentDepartmentId ?? '',
        defaultSummaryTemplate: department?.defaultSummaryTemplate ?? '',
      });
    }
  }, [open, department, form]);

  const parentOptions = departments.filter((d) => d.id !== department?.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="size-5" />
            {isEdit ? 'Edit Department' : 'Create Department'}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? `Update details for "${department?.name || department?.code || 'this department'}".`
              : 'Fill in the details to create a new department.'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Cardiology" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="code"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>
                      Code
                      <span className="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. CARD" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormDescription className="text-xs">Unique identifier per tenant</FormDescription>
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
                    <Textarea placeholder="Brief description of the department" rows={3} {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="parentDepartmentId"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>
                      Parent Department
                      <span className="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
                    </FormLabel>
                    <Select value={field.value || '_none'} onValueChange={(v: string) => field.onChange(v === '_none' ? '' : v)}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="None (root)" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="_none">None (root department)</SelectItem>
                        {parentOptions.map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name}
                            {d.code ? ` (${d.code})` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="defaultSummaryTemplate"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>
                      Summary Template
                      <span className="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. SOAP" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                {isEdit ? 'Save Changes' : 'Create Department'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// InlineDepartmentDetail — editable inline detail with tabs
// ---------------------------------------------------------------------------

function InlineDepartmentDetail({
  departmentId,
  tenantId,
  departments,
  prompts,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onDelete,
}: {
  departmentId: string;
  tenantId: string;
  departments: Department[];
  prompts: PromptTemplate[];
  onDelete: (dept: Department) => void;
}) {
  const { data: dept, isLoading } = useTenantDepartment(tenantId, departmentId);

  const updateMutation = useUpdateTenantDepartment(tenantId);
  const promptConfigMutation = useUpdateTenantDepartmentPromptConfig(tenantId);

  const detailsForm = useForm<DepartmentFormValues>({
    resolver: zodResolver(departmentSchema),
    defaultValues: {
      code: '',
      name: '',
      description: '',
      parentDepartmentId: '',
      defaultSummaryTemplate: '',
    },
  });

  const promptForm = useForm<PromptConfigValues>({
    resolver: zodResolver(promptConfigSchema),
    defaultValues: {
      preSummaryPromptId: '',
      newPatientPromptId: '',
      revisitPromptId: '',
    },
  });

  useEffect(() => {
    if (dept) {
      detailsForm.reset({
        code: dept.code ?? '',
        name: dept.name ?? '',
        description: dept.description ?? '',
        parentDepartmentId: dept.parentDepartmentId ?? '',
        defaultSummaryTemplate: dept.defaultSummaryTemplate ?? '',
      });
      promptForm.reset({
        preSummaryPromptId: dept.preSummaryPromptId ?? '',
        newPatientPromptId: dept.newPatientPromptId ?? '',
        revisitPromptId: dept.revisitPromptId ?? '',
      });
    }
  }, [dept, detailsForm, promptForm]);

  const parentOptions = useMemo(() => departments.filter((d) => d.id !== departmentId), [departments, departmentId]);

  const promptOptions = useMemo(() => prompts.filter((p) => (p.resourceStatus ?? 'ENABLED').toUpperCase() !== 'DISABLED'), [prompts]);

  const handleDetailsSave = useCallback(
    (values: DepartmentFormValues) => {
      updateMutation.mutate(
        {
          id: departmentId,
          name: values.name,
          code: values.code || undefined,
          description: values.description || undefined,
          parentDepartmentId: values.parentDepartmentId || null,
          defaultSummaryTemplate: values.defaultSummaryTemplate || undefined,
        },
        {
          onSuccess: (d) => toast.success(`Department "${d.name}" updated`),
          onError: (err) => toast.error(`Failed to update: ${err.message}`),
        },
      );
    },
    [departmentId, updateMutation],
  );

  const handlePromptSave = useCallback(
    (values: PromptConfigValues) => {
      promptConfigMutation.mutate(
        {
          id: departmentId,
          preSummaryPromptId: values.preSummaryPromptId || undefined,
          newPatientPromptId: values.newPatientPromptId || undefined,
          revisitPromptId: values.revisitPromptId || undefined,
        },
        {
          onSuccess: () => toast.success('Prompt configuration updated'),
          onError: (err) => toast.error(`Failed to update prompts: ${err.message}`),
        },
      );
    },
    [departmentId, promptConfigMutation],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-lg" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-28" />
          </div>
        </div>
        <Skeleton className="h-8 w-full rounded-md" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (!dept) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Building2 className="text-muted-foreground/50 mb-3 size-10" />
        <p className="text-muted-foreground text-sm">Department not found.</p>
      </div>
    );
  }

  const promptLookup = new Map<string, PromptTemplate>();
  prompts.forEach((p) => promptLookup.set(p.id, p));

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Info header */}
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg">
          <Building2 className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-lg font-semibold">{dept.name || 'Unnamed Department'}</h3>
            <StatusBadge status={String(dept.resourceStatus ?? 'ENABLED')} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {dept.code && (
              <Badge variant="secondary" className="font-mono text-xs">
                {dept.code}
              </Badge>
            )}
            <Badge variant="outline" className="text-xs">
              {dept.isRootDepartment ? 'Root' : 'Child'}
            </Badge>
          </div>
          {dept.description && <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{dept.description}</p>}
        </div>
      </div>

      {/* Prompt status badges */}
      <div className="flex flex-wrap gap-1.5">
        <PromptBadge
          label="New Patient"
          promptId={dept.newPatientPromptId}
          promptName={dept.newPatientPromptId ? promptLookup.get(dept.newPatientPromptId)?.name : undefined}
        />
        <PromptBadge
          label="Revisit"
          promptId={dept.revisitPromptId}
          promptName={dept.revisitPromptId ? promptLookup.get(dept.revisitPromptId)?.name : undefined}
        />
        <PromptBadge
          label="Pre-Summary"
          promptId={dept.preSummaryPromptId}
          promptName={dept.preSummaryPromptId ? promptLookup.get(dept.preSummaryPromptId)?.name : undefined}
        />
      </div>

      <Separator />

      {/* Tabs */}
      <Tabs defaultValue="details" className="flex-1">
        <TabsList className="w-full">
          <TabsTrigger value="details" className="flex-1">
            Details
          </TabsTrigger>
          <TabsTrigger value="prompts" className="flex-1">
            Prompt Config
          </TabsTrigger>
        </TabsList>

        {/* Details tab */}
        <TabsContent value="details" className="mt-4">
          <Form {...detailsForm}>
            <form onSubmit={detailsForm.handleSubmit(handleDetailsSave)} className="flex flex-col gap-4">
              <FormField
                control={detailsForm.control}
                name="name"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Cardiology" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={detailsForm.control}
                  name="code"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  render={({ field }: { field: any }) => (
                    <FormItem>
                      <FormLabel>
                        Code
                        <span className="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. CARD" {...field} value={field.value ?? ''} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={detailsForm.control}
                  name="parentDepartmentId"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  render={({ field }: { field: any }) => (
                    <FormItem>
                      <FormLabel>
                        Parent Department
                        <span className="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
                      </FormLabel>
                      <Select value={field.value || '_none'} onValueChange={(v: string) => field.onChange(v === '_none' ? '' : v)}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="None (root)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="_none">None (root department)</SelectItem>
                          {parentOptions.map((d) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.name}
                              {d.code ? ` (${d.code})` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={detailsForm.control}
                name="description"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>
                      Description
                      <span className="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Textarea placeholder="Brief description of the department" rows={3} {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={detailsForm.control}
                name="defaultSummaryTemplate"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>
                      Summary Template
                      <span className="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. SOAP" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={updateMutation.isPending}>
                  {updateMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Save Changes
                </Button>
              </div>
            </form>
          </Form>
        </TabsContent>

        {/* Prompt Config tab */}
        <TabsContent value="prompts" className="mt-4">
          <Form {...promptForm}>
            <form onSubmit={promptForm.handleSubmit(handlePromptSave)} className="flex flex-col gap-4">
              <FormField
                control={promptForm.control}
                name="newPatientPromptId"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>New Patient Prompt</FormLabel>
                    <Select value={field.value || '_none'} onValueChange={(v: string) => field.onChange(v === '_none' ? '' : v)}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Not assigned" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="max-h-72">
                        <SelectItem value="_none">
                          <span className="text-muted-foreground italic">Not assigned</span>
                        </SelectItem>
                        {promptOptions.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            <span className="truncate">{p.name}</span>
                            {p.category && (
                              <Badge variant="secondary" className="ml-2 shrink-0 text-[10px]">
                                {p.category}
                              </Badge>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription className="text-xs">Used for first-time or referral consultations</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={promptForm.control}
                name="revisitPromptId"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Revisit / Follow-up Prompt</FormLabel>
                    <Select value={field.value || '_none'} onValueChange={(v: string) => field.onChange(v === '_none' ? '' : v)}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Not assigned" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="max-h-72">
                        <SelectItem value="_none">
                          <span className="text-muted-foreground italic">Not assigned</span>
                        </SelectItem>
                        {promptOptions.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            <span className="truncate">{p.name}</span>
                            {p.category && (
                              <Badge variant="secondary" className="ml-2 shrink-0 text-[10px]">
                                {p.category}
                              </Badge>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription className="text-xs">Used for returning patient consultations</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={promptForm.control}
                name="preSummaryPromptId"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Pre-Summary Prompt</FormLabel>
                    <Select value={field.value || '_none'} onValueChange={(v: string) => field.onChange(v === '_none' ? '' : v)}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Not assigned" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="max-h-72">
                        <SelectItem value="_none">
                          <span className="text-muted-foreground italic">Not assigned</span>
                        </SelectItem>
                        {promptOptions.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            <span className="truncate">{p.name}</span>
                            {p.category && (
                              <Badge variant="secondary" className="ml-2 shrink-0 text-[10px]">
                                {p.category}
                              </Badge>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription className="text-xs">Used for pre-summary generation before the main summary</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={promptConfigMutation.isPending}>
                  {promptConfigMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Save Config
                </Button>
              </div>
            </form>
          </Form>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function DepartmentManagementPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('_all');

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Department | null>(null);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<string | null>(null);
  const [detailRefreshing, setDetailRefreshing] = useState(false);

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
      setSelectedTenantId(tenantId);
      setTenantKey(tenantId, tenants.find((t) => t.id === tenantId)?.name);
    },
    [tenants, setTenantKey],
  );

  // ---- Data ---------------------------------------------------------------

  const {
    data: departments = [],
    isLoading,
    isRefetching: departmentsRefreshing,
    refetch: refetchDepartments,
  } = useTenantDepartments(effectiveTenantId, {
    enabled: hasTenantContext,
  });

  const {
    data: promptsData,
    isRefetching: promptsRefreshing,
    refetch: refetchPrompts,
  } = usePromptTemplates(effectiveTenantId, { page: 1, limit: 200 });
  const prompts = promptsData?.data ?? [];
  const refreshDepartmentDetail = useRefreshTenantDepartmentDetail(effectiveTenantId);

  const filteredDepartments = useMemo(() => {
    let result = departments;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (d) =>
          (d.name && d.name.toLowerCase().includes(q)) ||
          (d.code && d.code.toLowerCase().includes(q)) ||
          (d.description && d.description.toLowerCase().includes(q)),
      );
    }
    if (statusFilter !== '_all') {
      result = result.filter((d) => (d.resourceStatus ?? 'ENABLED').toUpperCase() === statusFilter);
    }
    return result;
  }, [departments, search, statusFilter]);

  const selectedDepartment = useMemo(() => departments.find((dept) => dept.id === selectedDepartmentId) ?? null, [departments, selectedDepartmentId]);

  useEffect(() => {
    setSelectedDepartmentId(null);
    setDeleteTarget(null);
  }, [effectiveTenantId]);

  useEffect(() => {
    if (!selectedDepartmentId) return;
    const stillExists = departments.some((dept) => dept.id === selectedDepartmentId);
    if (!stillExists) {
      setSelectedDepartmentId(null);
      setDeleteTarget(null);
    }
  }, [departments, selectedDepartmentId]);

  // ---- Mutations ----------------------------------------------------------

  const createMutation = useCreateTenantDepartment(effectiveTenantId);
  const toggleMutation = useUpdateTenantDepartment(effectiveTenantId);
  const deleteMutation = useDeleteTenantDepartment(effectiveTenantId);

  // ---- Handlers -----------------------------------------------------------

  const handleCreate = useCallback(
    (values: DepartmentFormValues) => {
      createMutation.mutate(
        {
          code: values.code || undefined,
          name: values.name,
          description: values.description || undefined,
          parentDepartmentId: values.parentDepartmentId || undefined,
        },
        {
          onSuccess: (dept) => {
            toast.success(`Department "${dept.name}" created`);
            setCreateOpen(false);
          },
          onError: (err) => toast.error(`Failed to create department: ${err.message}`),
        },
      );
    },
    [createMutation],
  );

  const handleDelete = useCallback(() => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast.success(`Department "${deleteTarget.name || deleteTarget.code}" deleted`);
        setDeleteTarget(null);
        if (selectedDepartmentId === deleteTarget.id) setSelectedDepartmentId(null);
      },
      onError: (err) => toast.error(`Failed to delete department: ${err.message}`),
    });
  }, [deleteTarget, deleteMutation, selectedDepartmentId]);

  const handleToggleStatus = useCallback(
    (dept: Department) => {
      const current = (dept.resourceStatus ?? 'ENABLED').toUpperCase();
      const next = current === 'ENABLED' ? 'DISABLED' : 'ENABLED';
      toggleMutation.mutate(
        { id: dept.id, resourceStatus: next },
        {
          onSuccess: () => toast.success(`Department ${next === 'ENABLED' ? 'enabled' : 'disabled'}`),
          onError: (err) => toast.error(`Status update failed: ${err.message}`),
        },
      );
    },
    [toggleMutation],
  );

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
        <StatusBadge status={t.resourceStatus ?? 'ENABLED'} />
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

  const deptsColumn: MultiColumnConfig<Department> = {
    id: 'departments',
    title: 'Departments',
    showItemCount: true,
    width: '220px',
    skeletonCount: 5,
    skeletonHeight: 'h-14',
    estimateItemSize: 64,
    headerActions: (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <Input
            placeholder="Search departments…"
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            className="h-7 flex-1 text-xs"
          />
          <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setCreateOpen(true)} disabled={!hasTenantContext}>
            <Plus className="size-3.5" />
            New
          </Button>
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ),
    emptyIcon: <Building2 className="size-5" />,
    emptyTitle: !hasTenantContext ? 'No tenant selected' : 'No departments found',
    emptyDescription: !hasTenantContext ? 'Select a tenant to view departments.' : 'Create a department to get started.',
    onRefresh: hasTenantContext
      ? () => {
          void refetchDepartments();
          void refetchPrompts();
        }
      : undefined,
    isRefreshing: departmentsRefreshing || promptsRefreshing,
    keyExtractor: (d) => d.id,
    renderItem: (d) => {
      const isEnabled = (d.resourceStatus ?? 'ENABLED').toUpperCase() === 'ENABLED';
      return (
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-md">
            <Building2 className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className={cn('truncate text-sm font-medium', !isEnabled && 'text-muted-foreground line-through')}>{d.name || 'Unnamed'}</p>
            </div>
            <div className="flex items-center gap-1.5">
              {d.code && <span className="text-muted-foreground font-mono text-xs">{d.code}</span>}
              <Badge variant="outline" className="text-[10px]">
                {d.isRootDepartment ? 'Root' : 'Child'}
              </Badge>
            </div>
          </div>
          <Switch
            checked={isEnabled}
            onCheckedChange={() => handleToggleStatus(d)}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            disabled={toggleMutation.isPending}
            size="sm"
          />
        </div>
      );
    },
  };

  const deptsState: MultiColumnState<Department> = {
    data: filteredDepartments,
    isLoading,
    enabled: hasTenantContext,
    selectedId: selectedDepartmentId,
    onSelect: (id) => {
      if (id === selectedDepartmentId) return;
      setSelectedDepartmentId(id);
    },
  };

  const detailColumn: MultiColumnContentConfig = {
    type: 'content',
    id: 'detail',
    title: 'Department Detail',
    subtitle: selectedDepartment?.name ?? 'Select a department',
    width: '1fr',
    headerActions: selectedDepartment ? (
      <div className="flex items-center gap-2">
        <Switch
          checked={(selectedDepartment.resourceStatus ?? 'ENABLED').toUpperCase() === 'ENABLED'}
          onCheckedChange={() => handleToggleStatus(selectedDepartment)}
          disabled={toggleMutation.isPending}
          size="sm"
        />
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 text-destructive" onClick={() => setDeleteTarget(selectedDepartment)}>
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    ) : undefined,
    emptyIcon: <FolderTree className="size-5" />,
    emptyTitle: 'No department selected',
    emptyDescription: 'Select a department from the list to view details.',
    onRefresh:
      selectedDepartment && hasTenantContext
        ? async () => {
            setDetailRefreshing(true);
            try {
              await refreshDepartmentDetail(selectedDepartment.id);
            } finally {
              setDetailRefreshing(false);
            }
          }
        : undefined,
    isRefreshing: detailRefreshing || promptsRefreshing,
    renderContent: () => {
      if (!selectedDepartment) return null;
      return (
        <InlineDepartmentDetail
          departmentId={selectedDepartment.id}
          tenantId={effectiveTenantId}
          departments={departments}
          prompts={prompts}
          onDelete={(dept) => setDeleteTarget(dept)}
        />
      );
    },
  };

  const detailState: MultiColumnState<never> = {
    data: [],
    isLoading: false,
    enabled: !!selectedDepartment,
    selectedId: null,
    onSelect: () => {},
  };

  // ---- Render -------------------------------------------------------------

  return (
    <Main>
      <div className="mb-4">
        <h2 className="text-2xl font-bold tracking-tight">Department Management</h2>
        <p className="text-muted-foreground mt-1">Manage medical departments, hierarchy, and prompt template assignments.</p>
      </div>

      <MultiColumnLayout
        columns={[...(isSuperAdmin() ? [tenantsColumn] : []), deptsColumn, detailColumn]}
        columnStates={[...(isSuperAdmin() ? [tenantsState] : []), deptsState, detailState]}
        height="calc(100vh - 12rem)"
      />

      <DepartmentFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        departments={departments}
        isPending={createMutation.isPending}
        onSubmit={handleCreate}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        title="Delete Department"
        description={`Are you sure you want to delete "${deleteTarget?.name || deleteTarget?.code || 'this department'}"? This action cannot be undone. Departments with child departments cannot be deleted.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={deleteMutation.isPending}
      />
    </Main>
  );
}
