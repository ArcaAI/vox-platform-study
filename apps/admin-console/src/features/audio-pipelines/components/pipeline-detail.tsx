'use client';

import { useState, type FormEvent } from 'react';
import { IconStarFilled } from '@tabler/icons-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useCreatePipeline, usePipeline } from '../api';
import type { Pipeline } from '../api';
import { PipelineConfigTab } from './config-editor-card';
import { PipelineStatusBadge } from './pipeline-status-badge';
import { ClonePipelineDialog, TemplateBadge } from './template-lock';
import { PipelineLifecycleTab, PipelineVersionsTab } from './versions-lifecycle-panel';

type PipelineTab = 'config' | 'versions' | 'lifecycle';

const PIPELINE_TABS = ['config', 'versions', 'lifecycle'] as const;

const TAB_DEFS: { value: PipelineTab; label: string }[] = [
    { value: 'config', label: 'Config' },
    { value: 'versions', label: 'Versions' },
    { value: 'lifecycle', label: 'Lifecycle' },
];

/** Active detail tab in the URL (`?ptab=`), shared by the header list and body panels. */
function usePipelineTab() {
    return useQueryState('ptab', parseAsStringLiteral(PIPELINE_TABS).withDefault('config'));
}

function PipelineTabsList() {
    return (
        <TabsList variant="line">
            {TAB_DEFS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                    {tab.label}
                </TabsTrigger>
            ))}
        </TabsList>
    );
}

function PipelineMeta({ pipeline }: { pipeline: Pipeline }) {
    return (
        <>
            <span className="font-mono">{pipeline.slug}</span>
            <CopyButton value={pipeline.slug} label="Copy pipeline slug" />
            <span aria-hidden>&middot;</span>
            <span className="font-mono">{pipeline.id}</span>
            <CopyButton value={pipeline.id} label="Copy pipeline id" />
            <span aria-hidden>&middot;</span>
            <span>Updated {formatDateTime(pipeline.updatedAt)}</span>
        </>
    );
}

function DetailSkeleton() {
    return (
        <div className="flex flex-col gap-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-9 w-40" />
        </div>
    );
}

/** Frame 34 "+ New pipeline" — POST /admin/audio/pipelines, rendered in the drawer create mode. */
function CreatePipelineForm({ onCreated, onCancel }: { onCreated: (pipeline: Pipeline) => void; onCancel: () => void }) {
    const create = useCreatePipeline();
    const [form, setForm] = useState({ name: '', slug: '', configYaml: '' });

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        create.mutate(
            { name: form.name.trim(), slug: form.slug.trim(), configYaml: form.configYaml },
            {
                onSuccess: (pipeline) => {
                    toast.success(`Pipeline ${pipeline.name} created`);
                    onCreated(pipeline);
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the pipeline.'),
            },
        );
    }

    const ready = form.name.trim() && form.slug.trim() && form.configYaml.trim();

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">
                Creates an ASR pipeline for this tenant. Invalid YAML or a duplicate slug is rejected — use Validate in the config editor to
                preflight changes later.
            </p>
            <div className="flex flex-col gap-2">
                <Label htmlFor="create-pipeline-name">
                    Name
                    <span aria-hidden className="text-destructive">
                        *
                    </span>
                </Label>
                <Input
                    id="create-pipeline-name"
                    value={form.name}
                    onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Fast Clinical VI"
                    required
                />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="create-pipeline-slug">
                    Slug
                    <span aria-hidden className="text-destructive">
                        *
                    </span>
                </Label>
                <Input
                    id="create-pipeline-slug"
                    value={form.slug}
                    onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))}
                    placeholder="fast-clin-vi"
                    className="font-mono"
                    pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"
                    title="Lowercase alphanumeric with hyphens"
                    required
                />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="create-pipeline-yaml">
                    Config YAML
                    <span aria-hidden className="text-destructive">
                        *
                    </span>
                </Label>
                <Textarea
                    id="create-pipeline-yaml"
                    value={form.configYaml}
                    onChange={(event) => setForm((current) => ({ ...current, configYaml: event.target.value }))}
                    placeholder={'version: "1.0"\nmodels:\n  asr: whisper-large-v3'}
                    spellCheck={false}
                    className="min-h-40 font-mono text-xs"
                    required
                />
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={!ready || create.isPending}>
                    {create.isPending ? <Spinner /> : null}
                    Create pipeline
                </Button>
                <Button type="button" variant="outline" onClick={onCancel} disabled={create.isPending}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}

/**
 * Console-wide record detail for Audio Pipelines — a right slide-over (full-screen
 * sheet on mobile). Config (YAML editor, validate + OCC save) · Versions (config
 * snapshots) · Lifecycle (set default / enable-disable / assign-tenant / delete)
 * tabs; create mode reuses the same surface with a single create form. Replaces
 * the former three-column master-detail grid and the create dialog.
 */
export function PipelineDetailDrawer({
    pipelineId,
    creating,
    isElevated,
    onOpenChange,
    onCreated,
}: {
    pipelineId: string | null;
    creating: boolean;
    /** Gates the cross-tenant assign action in the Lifecycle tab. */
    isElevated: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: (pipeline: Pipeline) => void;
}) {
    const open = creating || pipelineId !== null;
    const [tab, setTab] = usePipelineTab();
    const detail = usePipeline(pipelineId);
    const pipeline = pipelineId ? (detail.data?.data ?? null) : null;
    const [cloneOpen, setCloneOpen] = useState(false);

    // Create mode: a single form, no tabs, no detail read.
    if (creating) {
        return (
            <DetailDrawer open={open} onOpenChange={onOpenChange} size="lg" title="New pipeline">
                <CreatePipelineForm onCreated={onCreated} onCancel={() => onOpenChange(false)} />
            </DetailDrawer>
        );
    }

    return (
        <>
        <Tabs value={tab} onValueChange={(next) => void setTab(next as PipelineTab)}>
            <DetailDrawer
                open={open}
                onOpenChange={onOpenChange}
                size="lg"
                title={pipeline ? pipeline.name : 'Pipeline'}
                badges={
                    pipeline ? (
                        <>
                            <PipelineStatusBadge status={pipeline.resourceStatus} />
                            {/* TASK-531 — a locked SYSTEM template copy. */}
                            {pipeline.templateLocked ? <TemplateBadge /> : null}
                            {pipeline.isDefault ? (
                                <Badge variant="secondary" className="gap-1">
                                    <IconStarFilled aria-hidden className="text-warning size-3" />
                                    Tenant default
                                </Badge>
                            ) : null}
                        </>
                    ) : null
                }
                meta={pipeline ? <PipelineMeta pipeline={pipeline} /> : null}
                tabs={pipeline ? <PipelineTabsList /> : null}
            >
                {!open ? null : detail.isPending ? (
                    <DetailSkeleton />
                ) : detail.error || !detail.data || !pipeline ? (
                    <ErrorState
                        error={detail.error ?? new GatewayError(404, 'This pipeline does not exist or is outside your access scope.')}
                        onRetry={() => void detail.refetch()}
                    />
                ) : (
                    <>
                        <TabsContent value="config" className="mt-0 flex min-h-0 flex-1 flex-col">
                            <PipelineConfigTab
                                detail={detail.data}
                                onReload={() => void detail.refetch()}
                                onClone={() => setCloneOpen(true)}
                            />
                        </TabsContent>
                        <TabsContent value="versions" className="mt-0">
                            <PipelineVersionsTab pipelineId={pipeline.id} />
                        </TabsContent>
                        <TabsContent value="lifecycle" className="mt-0">
                            <PipelineLifecycleTab
                                detail={detail.data}
                                isElevated={isElevated}
                                onReload={() => void detail.refetch()}
                                onDeleted={() => onOpenChange(false)}
                                onClone={() => setCloneOpen(true)}
                            />
                        </TabsContent>
                    </>
                )}
            </DetailDrawer>
        </Tabs>
        {/* Outside the Tabs/DetailDrawer tree so the dialog is not unmounted
            when the drawer closes on a successful clone. */}
        <ClonePipelineDialog source={pipeline} open={cloneOpen} onOpenChange={setCloneOpen} onCloned={onCreated} />
        </>
    );
}
