'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconCircleCheck, IconFileText, IconSearch } from '@tabler/icons-react';
import { toast } from 'sonner';
import { parseAsString, useQueryState } from 'nuqs';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { cn } from '@arcaai/ui';
import { GatewayError } from '@/shared/api';
import { useSession } from '@/shared/auth';
import { formatRelativeTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useApproveTemplate, useTemplate, useTemplates } from '../api';
import type { PromptTemplate, PromptTemplateStatus } from '../api';
import { VersionsPanel } from './versions-panel';

const STATUS_VARIANT: Record<PromptTemplateStatus, 'default' | 'secondary' | 'outline'> = {
    APPROVED: 'default',
    PUBLISHED: 'secondary',
    DRAFT: 'outline',
};

function statusLabel(status: PromptTemplateStatus): string {
    return status.charAt(0) + status.slice(1).toLowerCase();
}

/** Composite test score as a percentage chip (wire value is 0-100). */
function ScoreBadge({ score }: { score: number | undefined }) {
    if (score === undefined || score === null) return <span className="text-muted-foreground text-xs">no test yet</span>;
    const tone = score >= 80 ? 'text-success' : score >= 50 ? 'text-foreground' : 'text-destructive';
    return (
        <Badge variant="outline" className={cn('tabular-nums', tone)}>
            {Math.round(score)} / 100
        </Badge>
    );
}

/** Left rail: searchable/status-filtered template list. */
function TemplateList({
    selectedId,
    onSelect,
}: {
    selectedId: string | null;
    onSelect: (id: string) => void;
}) {
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState<'' | PromptTemplateStatus>('');
    const query = useTemplates({
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(status ? { status } : {}),
        limit: 50,
    });

    return (
        <Card className="flex min-h-0 flex-col gap-3 p-3 lg:h-full">
            <div className="flex flex-col gap-2">
                <div className="relative">
                    <IconSearch aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
                    <Input
                        aria-label="Search templates"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={'Search templates\u2026'}
                        className="h-8 pl-8 text-sm"
                    />
                </div>
                <NativeSelect
                    aria-label="Filter by status"
                    value={status}
                    onChange={(event) => setStatus(event.target.value as '' | PromptTemplateStatus)}
                    className="h-8 text-xs"
                >
                    <NativeSelectOption value="">All statuses</NativeSelectOption>
                    <NativeSelectOption value="DRAFT">Draft</NativeSelectOption>
                    <NativeSelectOption value="PUBLISHED">Published</NativeSelectOption>
                    <NativeSelectOption value="APPROVED">Approved</NativeSelectOption>
                </NativeSelect>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                {query.isPending ? (
                    <div className="flex flex-col gap-2">
                        {Array.from({ length: 6 }, (_, index) => (
                            <Skeleton key={index} className="h-12 w-full" />
                        ))}
                    </div>
                ) : query.error ? (
                    <ErrorState error={query.error} onRetry={() => void query.refetch()} />
                ) : query.data.data.length === 0 ? (
                    <EmptyState icon={IconFileText} title="No templates" description="No prompt templates match the current filters for this tenant." />
                ) : (
                    <ul aria-label="Prompt templates" className="flex flex-col gap-1">
                        {query.data.data.map((template) => (
                            <li key={template.id}>
                                <button
                                    type="button"
                                    onClick={() => onSelect(template.id)}
                                    aria-current={template.id === selectedId}
                                    className={cn(
                                        'hover:bg-accent flex w-full flex-col gap-1 rounded-md border p-2 text-left transition-colors',
                                        template.id === selectedId ? 'border-primary bg-accent' : 'border-transparent',
                                    )}
                                >
                                    <span className="flex items-center justify-between gap-2">
                                        <span className="min-w-0 truncate text-sm font-medium">{template.name}</span>
                                        <Badge variant={STATUS_VARIANT[template.status]} className="shrink-0 text-[10px]">
                                            {statusLabel(template.status)}
                                        </Badge>
                                    </span>
                                    <span className="text-muted-foreground flex items-center gap-2 text-xs">
                                        <span className="font-mono">v{template.currentVersionNumber}</span>
                                        <span aria-hidden>&middot;</span>
                                        <span className="truncate">{template.category}</span>
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </Card>
    );
}

/** Approve action panel — GLOBAL_ADMIN-only OCC write (If-Match). */
function ApprovePanel({ template, etag }: { template: PromptTemplate; etag: string | null }) {
    const uid = useId();
    const approve = useApproveTemplate();
    const [reason, setReason] = useState('');

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!etag) return;
        approve.mutate(
            { id: template.id, reason: reason.trim() || undefined, etag },
            {
                onSuccess: () => {
                    toast.success(`"${template.name}" approved for clinical use`);
                    setReason('');
                },
                onError: (error) => {
                    if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
                    toast.error(error instanceof GatewayError ? error.message : 'Could not approve the template.');
                },
            },
        );
    }

    return (
        <Card className="gap-3 p-4">
            <div className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold">Governance approval</h3>
                <p className="text-muted-foreground text-sm">
                    Approves the current version for clinical flows &mdash; <span className="font-mono text-xs">POST :id/approve</span> with If-Match; pins a
                    PromptVersion snapshot and writes a WORM change row. GLOBAL_ADMIN only.
                </p>
            </div>
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${uid}-reason`} className="text-muted-foreground text-xs font-medium">
                        Approval reason
                    </Label>
                    <Input
                        id={`${uid}-reason`}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        maxLength={500}
                        placeholder={'Why this template is cleared\u2026'}
                    />
                </div>
                <OccConflictAlert error={approve.error} onReload={() => approve.reset()} />
                <div className="flex justify-end">
                    <Button type="submit" disabled={!etag || approve.isPending}>
                        {approve.isPending ? <Spinner /> : <IconCircleCheck aria-hidden />}
                        Approve for clinical use
                    </Button>
                </div>
            </form>
        </Card>
    );
}

/** Right pane: metadata header, version history/diff and the approval panel. */
function TemplateDetail({ id, canApprove }: { id: string; canApprove: boolean }) {
    const query = useTemplate(id);

    if (query.isPending) {
        return (
            <div className="flex flex-col gap-4" aria-hidden>
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-56 w-full" />
            </div>
        );
    }
    if (query.error || !query.data) {
        return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    }

    const template = query.data.data;

    return (
        <div className="flex flex-col gap-4">
            <Card className="gap-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                        <h2 className="text-base font-semibold">{template.name}</h2>
                        {template.description ? <p className="text-muted-foreground text-sm">{template.description}</p> : null}
                    </div>
                    <Badge variant={STATUS_VARIANT[template.status]}>{statusLabel(template.status)}</Badge>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                    <div className="flex flex-col gap-0.5">
                        <dt className="text-muted-foreground text-xs">Version</dt>
                        <dd className="font-mono text-sm">v{template.currentVersionNumber}</dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <dt className="text-muted-foreground text-xs">Category</dt>
                        <dd className="text-sm">{template.category}</dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <dt className="text-muted-foreground text-xs">Last test score</dt>
                        <dd>
                            <ScoreBadge score={template.lastTestScore} />
                        </dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <dt className="text-muted-foreground text-xs">Last tested</dt>
                        <dd className="text-sm">{template.lastTestAt ? formatRelativeTime(template.lastTestAt) : '\u2014'}</dd>
                    </div>
                </dl>
            </Card>
            <VersionsPanel template={template} />
            {canApprove ? (
                <ApprovePanel template={template} etag={query.data.etag} />
            ) : (
                <Card className="p-4">
                    <p className="text-muted-foreground text-sm">Prompt approval is a global-admin privilege. You can review versions and scores here.</p>
                </Card>
            )}
        </div>
    );
}

/**
 * Prompt Studio (/prompt-studio, tier 10-19). Global-admin governance over
 * tenant prompt templates: browse the list, inspect version history + diffs +
 * the last deterministic test score, and APPROVE the current version for
 * clinical use. Templates are
 * tenant-owned, so the screen runs behind the working-tenant gate — a global
 * admin picks the tenant from the top-bar switcher.
 */
export function PromptStudioScreen() {
    const session = useSession();
    const canApprove = session.data?.isElevated ?? false;
    const [selectedId, setSelectedId] = useQueryState('template', parseAsString);

    return (
        <WorkingTenantGate
            title="Prompt Studio"
            meta={
                <span aria-hidden className="text-muted-foreground font-mono text-xs">
                    GET /admin/prompt-templates
                </span>
            }
            description="Prompt templates are tenant-owned. Pick a working tenant from the top-bar switcher to govern its prompts."
        >
            <ScreenTemplate
                header={<PageHeader title="Prompt Studio" meta={<span>versions &middot; diff &middot; test score &middot; clinical approval</span>} />}
                footer={
                    <StatusFooter
                        end={
                            <span aria-hidden className="font-mono">
                                POST /admin/prompt-templates/:id/approve
                            </span>
                        }
                    />
                }
            >
                <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
                    <TemplateList selectedId={selectedId} onSelect={(id) => void setSelectedId(id)} />
                    {selectedId ? (
                        <TemplateDetail id={selectedId} canApprove={canApprove} />
                    ) : (
                        <EmptyState
                            icon={IconFileText}
                            title="Select a template"
                            description="Choose a prompt template from the list to inspect its versions, diffs and approval state."
                        />
                    )}
                </div>
            </ScreenTemplate>
        </WorkingTenantGate>
    );
}
