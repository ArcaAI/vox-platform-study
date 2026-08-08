'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { IconBuildingCommunity, IconCheck, IconPlayerPlay, IconSelector } from '@tabler/icons-react';
import { toast } from 'sonner';
import { cn } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@arcaai/ui/components/shadcn/command';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Popover, PopoverContent, PopoverTrigger } from '@arcaai/ui/components/shadcn/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { ToggleGroup, ToggleGroupItem } from '@arcaai/ui/components/shadcn/toggle-group';
import { GatewayError } from '@/shared/api';
import { useTextProviders } from '@/shared/catalog';
import { formatDateTime, formatNumber, formatPercent, formatRelativeTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import {
  useAssignDepartment,
  useDepartments,
  useEvalGoldenCases,
  useEvalGoldenSets,
  useTemplate,
  useTestTemplate,
  useUsageAnalytics,
  useUsageRecords,
  useUsageStats,
  useVersions,
} from '../api/hooks';
import type { AssignDepartmentRequest, EvalGoldenCase, PromptTemplate, PromptUsageByDay } from '../api/types';

/** Sentinel Select values — Radix Select rejects an empty-string item value. */
const TENANT_DEFAULT = '__tenant_default__';
const DRAFT_VERSION = '__draft__';

type ExampleSource = 'sample' | 'golden';

const SLOT_OPTIONS = [
  { value: 'preSummaryPromptId', label: 'Pre-summary' },
  { value: 'newPatientPromptId', label: 'New patient' },
  { value: 'revisitPromptId', label: 'Revisit' },
] as const;

type SlotField = (typeof SLOT_OPTIONS)[number]['value'];

/** Sum of the analytics day buckets falling in the trailing 30-day window. */
function runsInLast30Days(byDay: PromptUsageByDay[]): number {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return byDay.filter((bucket) => bucket.day >= cutoff).reduce((sum, bucket) => sum + bucket.count, 0);
}

function StatRow({ label, loading, children }: { label: string; loading: boolean; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="tabular-nums">{loading ? <Skeleton className="h-4 w-14" /> : children}</dd>
    </div>
  );
}

/**
 * Assign the selected template to one of a department's prompt slots. The
 * gateway body requires the DEPARTMENT row's expectedVersion (E.2),
 * which the departments list read supplies per row.
 */
function AssignDepartmentDialog({
  template,
  open,
  onOpenChange,
}: {
  template: PromptTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const departmentsQuery = useDepartments();
  const assign = useAssignDepartment();
  const [departmentId, setDepartmentId] = useState('');
  const [slot, setSlot] = useState<SlotField>('preSummaryPromptId');

  const departments = departmentsQuery.data ?? [];
  const department = departments.find((row) => row.id === departmentId) ?? null;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setDepartmentId('');
      setSlot('preSummaryPromptId');
      assign.reset();
    }
    onOpenChange(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!department) return;
    const body: AssignDepartmentRequest = {
      departmentId: department.id,
      expectedVersion: department.version,
      [slot]: template.id,
    };
    assign.mutate(body, {
      onSuccess: () => {
        toast.success(`Assigned to ${department.code ?? department.name ?? department.id}`);
        handleOpenChange(false);
      },
      onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not assign the department.'),
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign to department</DialogTitle>
          <DialogDescription>
            Pins <span className="text-foreground font-medium">{template.name}</span> into a department prompt slot.{' '}
            <span className="font-mono text-xs">POST assign-department</span> (requires manage:Department).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="assign-department-id">
              Department{' '}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger id="assign-department-id" className="w-full">
                <SelectValue placeholder={departmentsQuery.isPending ? 'Loading departments\u2026' : 'Pick a department\u2026'} />
              </SelectTrigger>
              <SelectContent>
                {departments.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.code ?? row.name ?? row.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!departmentsQuery.isPending && departments.length === 0 ? (
              <p className="text-muted-foreground text-xs">No departments exist in this tenant yet.</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="assign-department-slot">Prompt slot</Label>
            <Select value={slot} onValueChange={(next) => setSlot(next as SlotField)}>
              <SelectTrigger id="assign-department-slot" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SLOT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={assign.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!department || assign.isPending}>
              {assign.isPending ? <Spinner /> : null}
              Assign
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Searchable combobox over one golden set's cases (PHI-safe metadata only —
 * see `EvalGoldenCase`). Client-side fuzzy filter over the fetched page
 * (`GoldenCaseListParams` carries no `search` param upstream); disabled until
 * a golden set is picked.
 */
function GoldenCasePicker({
  goldenSetId,
  value,
  onChange,
}: {
  goldenSetId: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const casesQuery = useEvalGoldenCases(goldenSetId || null, { limit: 200 });
  const cases = casesQuery.data?.items ?? [];
  const selected = cases.find((row) => row.id === value) ?? null;

  function caseLabel(row: EvalGoldenCase): string {
    return row.label?.trim() || row.id;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id="test-run-golden-case"
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={!goldenSetId}
          className={cn(
            'border-input flex min-h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm outline-none',
            'hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? caseLabel(selected) : goldenSetId ? 'Search golden cases…' : 'Pick a golden set first'}
          </span>
          <IconSelector aria-hidden="true" className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] min-w-64 p-0">
        <Command>
          <CommandInput placeholder="Search golden cases…" />
          <CommandList>
            {casesQuery.isFetching ? (
              <div className="text-muted-foreground py-6 text-center text-sm">Loading…</div>
            ) : cases.length === 0 ? (
              <div className="text-muted-foreground py-6 text-center text-sm">No cases in this set.</div>
            ) : (
              <CommandGroup>
                {cases.map((row) => {
                  const active = row.id === value;
                  return (
                    <CommandItem
                      key={row.id}
                      value={`${caseLabel(row)} ${row.id}`}
                      onSelect={() => {
                        onChange(row.id);
                        setOpen(false);
                      }}
                    >
                      <span className="flex-1 truncate">{caseLabel(row)}</span>
                      {active ? <IconCheck aria-hidden="true" className="text-primary size-4" /> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Frame 32 panel (c): dry-run the selected template (POST :id/test — an OCC
 * write with PATCH parity, so If-Match comes from the panel's own detail
 * read), assign it to a department slot, and summarize usage (analytics/usage
 * + :id/usage + a usage-records peek). Parents key this by template id.
 */
export function TestRunPanel({ template }: { template: PromptTemplate }) {
  // Detail read keeps the ETag the test run must present as If-Match.
  const detail = useTemplate(template.id);
  const runTest = useTestTemplate();
  const usageStats = useUsageStats(template.id);
  const analytics = useUsageAnalytics(template.id);
  const recentRuns = useUsageRecords({ promptTemplateId: template.id, page: 0, limit: 5 });
  const versionsQuery = useVersions(template.id);
  const [assignOpen, setAssignOpen] = useState(false);

  // Example data: "Paste sample" (free text) XOR "Golden case" (picked from a
  // golden set). Switching source clears the OTHER input so the payload can
  // never carry both fields at once.
  const [exampleSource, setExampleSource] = useState<ExampleSource>('sample');
  const [sampleInput, setSampleInput] = useState('');
  const [goldenSetId, setGoldenSetId] = useState('');
  const [goldenCaseId, setGoldenCaseId] = useState('');
  const goldenSetsQuery = useEvalGoldenSets({ limit: 200 }, { enabled: exampleSource === 'golden' });
  const goldenSets = goldenSetsQuery.data?.items ?? [];

  function handleSourceChange(next: string) {
    if (!next || next === exampleSource) return;
    setExampleSource(next as ExampleSource);
    if (next === 'golden') {
      setSampleInput('');
    } else {
      setGoldenSetId('');
      setGoldenCaseId('');
    }
  }

  // Provider/model: nothing selected ("Tenant default") omits both fields so
  // the HarnessPolicy cascade resolves them server-side.
  const providersQuery = useTextProviders();
  const providers = providersQuery.data ?? [];
  const [providerChoice, setProviderChoice] = useState(TENANT_DEFAULT);
  const [modelChoice, setModelChoice] = useState(TENANT_DEFAULT);
  const activeProvider = providers.find((provider) => provider.name === providerChoice) ?? null;

  const [dryRun, setDryRun] = useState(true);
  const [versionChoice, setVersionChoice] = useState(DRAFT_VERSION);
  const versions = [...(versionsQuery.data ?? [])].sort((a, b) => b.versionNumber - a.versionNumber);

  // The test result returns the row's NEW version, so consecutive runs
  // stay OCC-consistent without refetching the detail read.
  const etag = runTest.data ? `"${runTest.data.version}"` : (detail.data?.etag ?? null);
  const result = runTest.data;
  const occError =
    runTest.error instanceof GatewayError && (runTest.error.isVersionConflict || runTest.error.isMissingPrecondition) ? runTest.error : null;
  const missingGoldenCase = exampleSource === 'golden' && !goldenCaseId;

  function handleRun() {
    if (!etag || missingGoldenCase) return;
    const provider = providerChoice !== TENANT_DEFAULT ? providerChoice : undefined;
    const model = provider && modelChoice !== TENANT_DEFAULT ? modelChoice : undefined;
    const versionNumber = versionChoice !== DRAFT_VERSION ? Number(versionChoice) : undefined;
    runTest.mutate(
      {
        id: template.id,
        body: {
          ...(exampleSource === 'sample' ? { sampleInput: sampleInput || undefined } : { goldenCaseId }),
          dryRun,
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(versionNumber !== undefined ? { versionNumber } : {}),
        },
        etag,
      },
      {
        onError: (error) => {
          // A 412/428 renders the inline OCC alert instead of a toast.
          if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
          toast.error(error instanceof GatewayError ? error.message : 'The test run failed.');
        },
      },
    );
  }

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <h2 className="flex flex-wrap items-baseline gap-x-2 text-sm leading-none font-semibold">
          Test run
          <span aria-hidden className="text-muted-foreground font-mono text-xs font-normal">
            POST :id/test
          </span>
        </h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        <OccConflictAlert
          error={occError}
          onReload={() => {
            void detail.refetch();
            runTest.reset();
          }}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="test-run-provider">Provider</Label>
            <Select
              value={providerChoice}
              onValueChange={(next) => {
                setProviderChoice(next);
                setModelChoice(TENANT_DEFAULT);
              }}
            >
              <SelectTrigger id="test-run-provider" className="w-full">
                <SelectValue placeholder={providersQuery.isPending ? 'Loading providers\u2026' : undefined} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TENANT_DEFAULT}>Tenant default</SelectItem>
                {providers.map((provider) => (
                  <SelectItem key={provider.name} value={provider.name} disabled={!provider.is_available}>
                    {provider.name}
                    {provider.is_default ? ' (default)' : ''}
                    {provider.is_available ? '' : ' (unavailable)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {providerChoice !== TENANT_DEFAULT ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="test-run-model">Model</Label>
              <Select value={modelChoice} onValueChange={setModelChoice}>
                <SelectTrigger id="test-run-model" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TENANT_DEFAULT}>Tenant default model</SelectItem>
                  {(activeProvider?.models ?? []).map((model) => (
                    <SelectItem key={model.name} value={model.name}>
                      {model.name}
                      {activeProvider?.is_default && model.name === activeProvider.default_model ? ' (default)' : ''}
                      {model.size ? ` \u00b7 ${model.size}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="test-run-version">Version</Label>
          <Select value={versionChoice} onValueChange={setVersionChoice}>
            <SelectTrigger id="test-run-version" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DRAFT_VERSION}>Draft (current)</SelectItem>
              {versions.map((version) => (
                <SelectItem key={version.id} value={String(version.versionNumber)}>
                  v{version.versionNumber}
                  {version.versionNumber === template.currentVersionNumber ? ' (current)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Example data</span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Example data source"
            value={exampleSource}
            onValueChange={handleSourceChange}
            className="self-start"
          >
            <ToggleGroupItem value="sample">Paste sample</ToggleGroupItem>
            <ToggleGroupItem value="golden">Golden case</ToggleGroupItem>
          </ToggleGroup>
          {exampleSource === 'sample' ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="test-run-sample-input">Sample input</Label>
              <Textarea
                id="test-run-sample-input"
                value={sampleInput}
                onChange={(event) => setSampleInput(event.target.value)}
                placeholder={'Paste a sample transcript excerpt\u2026'}
                className="min-h-24 resize-none font-mono text-xs"
              />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="test-run-golden-set">Golden set</Label>
                <Select
                  value={goldenSetId}
                  onValueChange={(next) => {
                    setGoldenSetId(next);
                    setGoldenCaseId('');
                  }}
                >
                  <SelectTrigger id="test-run-golden-set" className="w-full">
                    <SelectValue placeholder={goldenSetsQuery.isPending ? 'Loading golden sets\u2026' : 'Pick a golden set\u2026'} />
                  </SelectTrigger>
                  <SelectContent>
                    {goldenSets.map((set) => (
                      <SelectItem key={set.id} value={set.id}>
                        {set.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!goldenSetsQuery.isPending && goldenSets.length === 0 ? (
                  <p className="text-muted-foreground text-xs">No golden sets in this tenant yet.</p>
                ) : null}
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="test-run-golden-case">Golden case</Label>
                <GoldenCasePicker goldenSetId={goldenSetId} value={goldenCaseId} onChange={setGoldenCaseId} />
              </div>
            </div>
          )}
        </div>
        <div className="flex items-start justify-between gap-3 rounded-md border p-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Label htmlFor="test-run-dry-run">Dry run</Label>
            <p className="text-muted-foreground text-xs">Don&rsquo;t save results to the template &mdash; the row&rsquo;s OCC version is unaffected.</p>
          </div>
          <Switch id="test-run-dry-run" checked={dryRun} onCheckedChange={setDryRun} />
        </div>
        <Button size="sm" className="self-start" disabled={!etag || runTest.isPending || missingGoldenCase} onClick={handleRun}>
          {runTest.isPending ? <Spinner /> : <IconPlayerPlay aria-hidden />}
          Run test
        </Button>
        {result ? (
          <div className="flex flex-col gap-1.5">
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
              <span>
                Score <span className="text-foreground font-medium tabular-nums">{formatPercent(result.score * 100)}</span>
              </span>
              <span aria-hidden>{'\u00b7'}</span>
              <span>{formatDateTime(result.testedAt)}</span>
            </div>
            <pre className="bg-muted/40 max-h-56 overflow-y-auto rounded-md border p-2 font-mono text-xs break-words whitespace-pre-wrap">
              {result.output}
            </pre>
          </div>
        ) : null}
        <Separator />
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Assign department</h3>
          <Button variant="outline" size="sm" className="self-start" onClick={() => setAssignOpen(true)}>
            <IconBuildingCommunity aria-hidden />
            Assign to department
          </Button>
        </div>
        <Separator />
        <div className="flex flex-col gap-2">
          <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
            Usage analytics
            <span aria-hidden className="text-muted-foreground font-mono text-xs font-normal">
              GET analytics/usage
            </span>
          </h3>
          <dl className="flex flex-col gap-1.5">
            <StatRow label="Runs (30d)" loading={analytics.isPending}>
              {analytics.data ? formatNumber(runsInLast30Days(analytics.data.byDay)) : '\u2014'}
            </StatRow>
            <StatRow label="Total runs" loading={usageStats.isPending}>
              {usageStats.data ? formatNumber(usageStats.data.totalUsages) : '\u2014'}
            </StatRow>
            <StatRow label="Last used" loading={usageStats.isPending}>
              {usageStats.data?.lastUsedAt ? formatRelativeTime(usageStats.data.lastUsedAt) : 'Never'}
            </StatRow>
            <StatRow label="Last test score" loading={false}>
              {template.lastTestScore !== undefined ? formatPercent(template.lastTestScore * 100) : '\u2014'}
            </StatRow>
          </dl>
          <h4 className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 text-xs font-medium">
            Recent runs
            <span aria-hidden className="font-mono font-normal">
              GET usage-records
            </span>
          </h4>
          {recentRuns.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : (recentRuns.data?.data.length ?? 0) === 0 ? (
            <p className="text-muted-foreground text-xs">No runs recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {(recentRuns.data?.data ?? []).map((run) => (
                <li key={run.id} className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono">
                    {run.promptVersionNumber !== null && run.promptVersionNumber !== undefined ? `v${run.promptVersionNumber}` : '\u2014'}
                  </span>
                  <span>{formatRelativeTime(run.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
      <AssignDepartmentDialog template={template} open={assignOpen} onOpenChange={setAssignOpen} />
    </Card>
  );
}
