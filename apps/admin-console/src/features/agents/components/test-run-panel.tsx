'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { IconBuildingCommunity, IconPlayerPlay } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@arcaai/ui/components/shadcn/select';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { formatDateTime, formatNumber, formatPercent, formatRelativeTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { useAssignDepartment, useDepartments, useTemplate, useTestTemplate, useUsageAnalytics, useUsageRecords, useUsageStats } from '../api/hooks';
import type { AssignDepartmentRequest, PromptTemplate, PromptUsageByDay } from '../api/types';

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
 * gateway body requires the DEPARTMENT row's expectedVersion (TASK-302 E.2),
 * which the departments list read supplies per row.
 */
function AssignDepartmentDialog({ template, open, onOpenChange }: { template: PromptTemplate; open: boolean; onOpenChange: (open: boolean) => void }) {
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
    const [sampleInput, setSampleInput] = useState('');
    const [assignOpen, setAssignOpen] = useState(false);

    // The test result returns the row's NEW version, so consecutive runs
    // stay OCC-consistent without refetching the detail read.
    const etag = runTest.data ? `"${runTest.data.version}"` : (detail.data?.etag ?? null);
    const result = runTest.data;
    const occError =
        runTest.error instanceof GatewayError && (runTest.error.isVersionConflict || runTest.error.isMissingPrecondition) ? runTest.error : null;

    function handleRun() {
        if (!etag) return;
        runTest.mutate(
            { id: template.id, body: { sampleInput: sampleInput || undefined }, etag },
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
                <Button size="sm" className="self-start" disabled={!etag || runTest.isPending} onClick={handleRun}>
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
                                    <span className="font-mono">{run.promptVersionNumber !== null && run.promptVersionNumber !== undefined ? `v${run.promptVersionNumber}` : '\u2014'}</span>
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
