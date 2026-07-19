'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { IconDna } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { NameWithId } from '@/shared/data/name-with-id';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime, formatRelativeTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useDnaVersions, useDoctorReport, useUpdateDnaReport } from '../api';
import type { DnaReport } from '../api';

function isOccError(error: unknown): boolean {
    return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/** GET :reportId/versions — the DnaVersion history, newest first (frame 33). */
function VersionTimeline({ reportId }: { reportId: string }) {
    const versions = useDnaVersions(reportId);

    if (versions.isPending) {
        return (
            <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
            </div>
        );
    }
    if (versions.isError) {
        return <ErrorState title={'Couldn’t load the version timeline'} error={versions.error} onRetry={() => void versions.refetch()} />;
    }
    if (versions.data.length === 0) {
        return <p className="text-muted-foreground text-xs">No versions recorded yet.</p>;
    }

    const rows = [...versions.data].sort((a, b) => b.versionNumber - a.versionNumber);
    return (
        <ol aria-label="Version timeline" className="flex flex-col">
            {rows.map((version) => (
                <li key={version.id} className="flex items-baseline gap-2 border-b py-1.5 text-xs last:border-0">
                    <span className="font-medium tabular-nums">v{version.versionNumber}</span>
                    <time dateTime={version.createdAt} className="text-muted-foreground shrink-0">
                        {formatDateTime(version.createdAt, 'date')}
                    </time>
                    <span className="text-muted-foreground min-w-0 flex-1 truncate" title={version.changeReason}>
                        {version.changeReason || 'auto-generate'}
                    </span>
                </li>
            ))}
        </ol>
    );
}

/**
 * PATCH :reportId editor for the DTO's editable fields (styleText +
 * changeReason). If-Match carries the read ETag; a 412 renders the
 * OccConflictAlert with the draft kept locally.
 */
function ReportEditor({ report, etag, onDone, onReload }: { report: DnaReport; etag: string; onDone: () => void; onReload: () => void }) {
    const update = useUpdateDnaReport();
    const [styleText, setStyleText] = useState(report.styleText ?? '');
    const [changeReason, setChangeReason] = useState('');

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        update.mutate(
            { reportId: report.id, patch: { styleText, ...(changeReason.trim() ? { changeReason: changeReason.trim() } : {}) }, etag },
            {
                onSuccess: () => {
                    toast.success('Report updated');
                    onDone();
                },
                onError: (error) => {
                    // OCC failures render inline below; anything else toasts.
                    if (!isOccError(error)) {
                        toast.error(error instanceof GatewayError ? error.message : 'Could not update the report.');
                    }
                },
            },
        );
    }

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <OccConflictAlert
                error={update.error}
                onReload={() => {
                    update.reset();
                    onReload();
                }}
            />
            <div className="flex flex-col gap-2">
                <Label htmlFor="dna-style-text">Style text</Label>
                <Textarea
                    id="dna-style-text"
                    value={styleText}
                    onChange={(event) => setStyleText(event.target.value)}
                    rows={6}
                    className="resize-none text-sm"
                />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="dna-change-reason">Change reason</Label>
                <Input
                    id="dna-change-reason"
                    value={changeReason}
                    onChange={(event) => setChangeReason(event.target.value)}
                    placeholder="Why this edit (kept in the version history)"
                />
            </div>
            <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={onDone} disabled={update.isPending}>
                    Cancel
                </Button>
                <Button type="submit" size="sm" disabled={update.isPending}>
                    {update.isPending ? <Spinner /> : null}
                    Save
                </Button>
            </div>
        </form>
    );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2 text-sm">
            <span className="text-muted-foreground text-xs">{label}</span>
            <span className="min-w-0">{children}</span>
        </div>
    );
}

function DetailSkeleton() {
    return (
        <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-4 w-1/2" />
        </div>
    );
}

function DoctorMeta({ report }: { report: DnaReport }) {
    return (
        <>
            <span className="text-muted-foreground">Report ID</span>
            <span className="font-mono break-all">{report.id}</span>
            <CopyButton value={report.id} label="Copy report id" />
            <span aria-hidden>&middot;</span>
            <span>Updated {formatRelativeTime(report.updatedAt)}</span>
            <span aria-hidden>&middot;</span>
            <span className="font-mono">GET /doctor/:doctorId</span>
        </>
    );
}

/**
 * Frame 33 detail surface (redesign) — the selected doctor's latest report
 * (GET doctor/:doctorId, kept WithEtag for the OCC PATCH) plus the DnaVersion
 * timeline, rendered in the console-wide `DetailDrawer` (right slide-over on
 * desktop, full-screen sheet on mobile). The style-text editor (If-Match OCC)
 * stays inside. PHI: doctor reads stay tenant-pinned even for global admins, so
 * a cross-tenant doctor id surfaces as the 404 empty state with a Generate CTA.
 */
export function DoctorDetailDrawer({
    doctorId,
    onOpenChange,
    onGenerate,
}: {
    doctorId: string | null;
    onOpenChange: (open: boolean) => void;
    onGenerate: () => void;
}) {
    const open = doctorId !== null;
    const report = useDoctorReport(doctorId ?? '');
    const [editing, setEditing] = useState(false);

    const payload = report.data?.data ?? null;
    // ETag preferred; the DTO's OCC `version` field backs it up (rule 05: the
    // ETagInterceptor mirrors `_version`, so both carry the same token).
    const etag = report.data?.etag ?? (payload ? `"${payload.version}"` : null);
    const isNotFound = report.error instanceof GatewayError && report.error.isNotFound;

    let body: ReactNode = null;
    if (!open) {
        body = null;
    } else if (report.isPending) {
        body = <DetailSkeleton />;
    } else if (report.isError) {
        body = isNotFound ? (
            <EmptyState
                icon={IconDna}
                title="No report for this doctor yet"
                description="Generate the first writing-style report to see it here. Cross-tenant doctors also land on this state (404-over-403)."
                action={
                    <Button size="sm" onClick={onGenerate}>
                        <IconDna aria-hidden />
                        Generate report
                    </Button>
                }
            />
        ) : (
            <ErrorState error={report.error} onRetry={() => void report.refetch()} />
        );
    } else if (payload) {
        body = (
            <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                    <DetailRow label="Doctor">
                        <NameWithId name={payload.doctorUsername} id={payload.doctorId} />
                    </DetailRow>
                    <DetailRow label="Version">
                        <span className="flex flex-wrap items-center gap-2">
                            <span className="tabular-nums">v{payload.currentVersionNumber}</span>
                            {payload.isLatest ? <Badge variant="secondary">Latest</Badge> : null}
                        </span>
                    </DetailRow>
                    <DetailRow label="Updated">
                        <span className="text-muted-foreground">{formatRelativeTime(payload.updatedAt)}</span>
                    </DetailRow>
                </div>

                <div className="flex flex-col gap-2">
                    {!editing ? (
                        <div className="flex items-center justify-between gap-2">
                            <h3 className="text-xs font-semibold">Style text</h3>
                            <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={!etag}>
                                Edit
                            </Button>
                        </div>
                    ) : null}
                    {editing && etag ? (
                        <ReportEditor report={payload} etag={etag} onDone={() => setEditing(false)} onReload={() => void report.refetch()} />
                    ) : (
                        <p className="text-muted-foreground line-clamp-6 text-sm whitespace-pre-wrap">
                            {payload.styleText || 'No style text extracted.'}
                        </p>
                    )}
                </div>

                <div className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold">Version timeline</h3>
                    <VersionTimeline reportId={payload.id} />
                </div>

                <p className="text-muted-foreground border-t pt-3 text-xs">
                    PHI guard: doctor reads stay tenant-pinned even for global admins.
                </p>
            </div>
        );
    }

    return (
        <DetailDrawer
            open={open}
            onOpenChange={onOpenChange}
            size="lg"
            title={payload ? (payload.doctorUsername ?? payload.doctorId) : 'Doctor detail'}
            badges={payload ? <ResourceStatusBadge status={payload.resourceStatus} /> : null}
            meta={payload ? <DoctorMeta report={payload} /> : null}
            footer={
                payload ? (
                    <Button variant="outline" size="sm" onClick={onGenerate}>
                        <IconDna aria-hidden />
                        Generate report
                    </Button>
                ) : null
            }
        >
            {body}
        </DetailDrawer>
    );
}
