'use client';

/**
 * DepartmentAgent detail drawer (TASK-547) — the console-wide `DetailDrawer`
 * hosting one Agent Catalog row. Header: name + Default/Locked badges → meta
 * line (department · Agent Template · version state) → tabs:
 *   - Settings: name / Agent Template / DNA writing-style gate (the ticket's
 *     explicit edit-field list), OCC PATCH with If-Match.
 *   - Version: current pin state + pin/track-latest controls (`POST :id/pin`).
 *   - History: the bound Agent Template's version timeline (read-only reuse
 *     of `VersionsPanel` — the same content a "History" tab would show, so no
 *     separate audit surface is invented for it).
 *
 * A `templateLocked` row ("cloned from library") renders Settings/Version
 * read-only and hides Delete — mirrors the AsrPipeline lineage lock
 * (`03-domain-layer.md` exemplar). There is no clone action yet (TASK-548);
 * per the ticket's own hazard note this stays absent rather than a stub.
 */

import { useId, useState, type FormEvent } from 'react';
import { IconLock, IconTrash } from '@tabler/icons-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import {
    useCreateDepartmentAgent,
    useDepartmentAgent,
    useDepartments,
    useEvalGoldenSets,
    usePinDepartmentAgent,
    useTemplate,
    useTemplates,
    useUpdateDepartmentAgent,
    useVersions,
} from '../api/hooks';
import type { CreateDepartmentAgentRequest, DepartmentAgent, DepartmentAgentDnaPolicy } from '../api/types';
import { versionStateLabel } from './agents-tab';
import { VersionsPanel } from './versions-panel';

type AgentCatalogTab = 'settings' | 'version' | 'history';
const AGENT_CATALOG_TABS = ['settings', 'version', 'history'] as const;

const DNA_POLICY_OPTIONS: { value: DepartmentAgentDnaPolicy; label: string }[] = [
    { value: 'INHERIT', label: 'Inherit' },
    { value: 'DISABLED', label: 'Disabled' },
];

/** Radix `Select` rejects an empty-string item value, so "no golden set" needs a sentinel (TASK-549). */
const NO_GOLDEN_SET = '__none__';

function useAgentCatalogTab() {
    return useQueryState('catab', parseAsStringLiteral(AGENT_CATALOG_TABS).withDefault('settings'));
}

function RequiredMark() {
    return (
        <span aria-hidden className="text-destructive">
            *
        </span>
    );
}

function FormActions({ children }: { children: React.ReactNode }) {
    return <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>;
}

function LockedHint() {
    return (
        <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <IconLock aria-hidden className="size-4" />
            Cloned from library — clone to customize.
        </p>
    );
}

function CatalogTabsList() {
    return (
        <TabsList variant="line">
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="version">Version</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
    );
}

function AgentMeta({ agent, departmentLabel, templateName }: { agent: DepartmentAgent; departmentLabel: string | null; templateName: string | null }) {
    return (
        <>
            <span className="font-mono">{agent.id}</span>
            <CopyButton value={agent.id} label="Copy agent id" />
            <span aria-hidden>&middot;</span>
            <span>{departmentLabel ?? agent.departmentId}</span>
            <span aria-hidden>&middot;</span>
            <span>{templateName ?? agent.promptTemplateId}</span>
        </>
    );
}

function DetailSkeleton() {
    return (
        <div className="flex flex-col gap-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-40 w-full" />
        </div>
    );
}

/** Create form body — no dialog chrome, hosted in the drawer's create mode. */
function CreateAgentForm({ onCreated, onCancel }: { onCreated: (agent: DepartmentAgent) => void; onCancel: () => void }) {
    const createAgent = useCreateDepartmentAgent();
    const departmentsQuery = useDepartments();
    const [departmentId, setDepartmentId] = useState('');
    const [name, setName] = useState('');
    const [promptTemplateId, setPromptTemplateId] = useState('');
    const [dnaStylePolicy, setDnaStylePolicy] = useState<DepartmentAgentDnaPolicy>('INHERIT');
    const templatesQuery = useTemplates({ limit: 200 });

    const templateOptions = (templatesQuery.data?.data ?? []).filter(
        (template) => !template.departmentId || template.departmentId === departmentId,
    );

    function slugify(value: string): string {
        return value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const slug = slugify(name);
        if (!departmentId || !name.trim() || !promptTemplateId || !slug) return;
        const body: CreateDepartmentAgentRequest = { departmentId, name: name.trim(), slug, promptTemplateId, dnaStylePolicy };
        createAgent.mutate(body, {
            onSuccess: (agent) => {
                toast.success(`Agent "${agent.name}" created`);
                onCreated(agent);
            },
            onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the agent.'),
        });
    }

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
                <Label htmlFor="create-agent-department">
                    Department <RequiredMark />
                </Label>
                <Select value={departmentId} onValueChange={setDepartmentId}>
                    <SelectTrigger id="create-agent-department" className="w-full">
                        <SelectValue placeholder="Choose a department" />
                    </SelectTrigger>
                    <SelectContent>
                        {(departmentsQuery.data ?? []).map((department) => (
                            <SelectItem key={department.id} value={department.id}>
                                {department.code ?? department.name ?? department.id}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="create-agent-name">
                    Name <RequiredMark />
                </Label>
                <Input
                    id="create-agent-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. Cardiology SOAP"
                    autoComplete="off"
                    required
                />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="create-agent-template">
                    Agent template <RequiredMark />
                </Label>
                <Select value={promptTemplateId} onValueChange={setPromptTemplateId}>
                    <SelectTrigger id="create-agent-template" className="w-full">
                        <SelectValue placeholder="Choose an Agent Template" />
                    </SelectTrigger>
                    <SelectContent>
                        {templateOptions.map((template) => (
                            <SelectItem key={template.id} value={template.id}>
                                {template.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="create-agent-dna">DNA writing-style gate</Label>
                <Select value={dnaStylePolicy} onValueChange={(next) => setDnaStylePolicy(next as DepartmentAgentDnaPolicy)}>
                    <SelectTrigger id="create-agent-dna" className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {DNA_POLICY_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <FormActions>
                <Button type="button" variant="outline" onClick={onCancel} disabled={createAgent.isPending}>
                    Cancel
                </Button>
                <Button type="submit" disabled={!departmentId || !name.trim() || !promptTemplateId || createAgent.isPending}>
                    {createAgent.isPending ? <Spinner /> : null}
                    Create agent
                </Button>
            </FormActions>
        </form>
    );
}

/** Settings tab: name / Agent Template / DNA gate — the ticket's explicit edit-field list. */
function SettingsForm({
    agent,
    etag,
    onSaved,
    onReload,
}: {
    agent: DepartmentAgent;
    etag: string | null;
    onSaved: () => void;
    onReload: () => void;
}) {
    const updateAgent = useUpdateDepartmentAgent();
    const templatesQuery = useTemplates({ departmentId: agent.departmentId, limit: 200 });
    const goldenSetsQuery = useEvalGoldenSets({ limit: 200 });
    const [name, setName] = useState(agent.name);
    const [promptTemplateId, setPromptTemplateId] = useState(agent.promptTemplateId);
    const [dnaStylePolicy, setDnaStylePolicy] = useState<DepartmentAgentDnaPolicy>(agent.dnaStylePolicy);
    const [goldenSetId, setGoldenSetId] = useState<string>(agent.goldenSetId ?? NO_GOLDEN_SET);
    const occError =
        updateAgent.error instanceof GatewayError && (updateAgent.error.isVersionConflict || updateAgent.error.isMissingPrecondition)
            ? updateAgent.error
            : null;
    const goldenSetOptions = goldenSetsQuery.data?.items ?? [];
    const attachedGoldenSetName = agent.goldenSetId ? (goldenSetOptions.find((set) => set.id === agent.goldenSetId)?.name ?? agent.goldenSetId) : null;

    if (agent.templateLocked) {
        return (
            <div className="flex flex-col gap-4">
                <LockedHint />
                <div className="flex flex-col gap-2">
                    <Label htmlFor="agent-name-locked">Name</Label>
                    <Input id="agent-name-locked" value={agent.name} disabled />
                </div>
                <div className="flex flex-col gap-2">
                    <Label htmlFor="agent-dna-locked">DNA writing-style gate</Label>
                    <Input id="agent-dna-locked" value={agent.dnaStylePolicy} disabled />
                </div>
                <div className="flex flex-col gap-2">
                    <Label htmlFor="agent-golden-set-locked">Golden set</Label>
                    <Input id="agent-golden-set-locked" value={attachedGoldenSetName ?? 'None — eval gate off'} disabled />
                </div>
            </div>
        );
    }

    // The bound template may not be in the department-filtered list (e.g. a
    // tenant-wide template) — keep it selectable regardless.
    const templateOptions = templatesQuery.data?.data ?? [];
    const hasCurrentTemplate = templateOptions.some((template) => template.id === promptTemplateId);

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!etag) return;
        updateAgent.mutate(
            {
                id: agent.id,
                patch: {
                    name: name.trim(),
                    promptTemplateId,
                    dnaStylePolicy,
                    goldenSetId: goldenSetId === NO_GOLDEN_SET ? null : goldenSetId,
                },
                etag,
            },
            {
                onSuccess: () => {
                    toast.success('Agent updated');
                    onSaved();
                },
                onError: (error) => {
                    if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
                    toast.error(error instanceof GatewayError ? error.message : 'Could not update the agent.');
                },
            },
        );
    }

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <OccConflictAlert
                error={occError}
                onReload={() => {
                    onReload();
                    updateAgent.reset();
                }}
            />
            <div className="flex flex-col gap-2">
                <Label htmlFor="agent-name">
                    Name <RequiredMark />
                </Label>
                <Input id="agent-name" aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" required />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="agent-template">
                    Agent template <RequiredMark />
                </Label>
                <Select value={promptTemplateId} onValueChange={setPromptTemplateId}>
                    <SelectTrigger id="agent-template" className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {!hasCurrentTemplate ? (
                            <SelectItem value={promptTemplateId}>{promptTemplateId}</SelectItem>
                        ) : null}
                        {templateOptions.map((template) => (
                            <SelectItem key={template.id} value={template.id}>
                                {template.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="agent-dna">DNA writing-style gate</Label>
                <Select value={dnaStylePolicy} onValueChange={(next) => setDnaStylePolicy(next as DepartmentAgentDnaPolicy)}>
                    <SelectTrigger id="agent-dna" className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {DNA_POLICY_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="agent-golden-set">Golden set</Label>
                <Select value={goldenSetId} onValueChange={setGoldenSetId}>
                    <SelectTrigger id="agent-golden-set" className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={NO_GOLDEN_SET}>None — eval gate off</SelectItem>
                        {goldenSetId !== NO_GOLDEN_SET && !goldenSetOptions.some((set) => set.id === goldenSetId) ? (
                            <SelectItem value={goldenSetId}>{goldenSetId}</SelectItem>
                        ) : null}
                        {goldenSetOptions.map((set) => (
                            <SelectItem key={set.id} value={set.id}>
                                {set.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                    Gates promotion: approving this agent&apos;s template (or re-pointing its pin) runs an eval against this set first.
                </p>
            </div>
            <FormActions>
                <Button type="submit" disabled={!name.trim() || !etag || updateAgent.isPending}>
                    {updateAgent.isPending ? <Spinner /> : null}
                    Save changes
                </Button>
            </FormActions>
        </form>
    );
}

/** Version tab: current pin state + pin-to-version / track-latest-approved actions. */
function PinControl({ agent, onChanged }: { agent: DepartmentAgent; onChanged: () => void }) {
    const uid = useId();
    const pin = usePinDepartmentAgent();
    const templateQuery = useTemplate(agent.promptTemplateId);
    const versionsQuery = useVersions(agent.promptTemplateId);
    const [picked, setPicked] = useState('');

    const template = templateQuery.data?.data ?? null;
    const versions = [...(versionsQuery.data ?? [])].sort((a, b) => b.versionNumber - a.versionNumber);
    const currentLabel = versionStateLabel(agent, template?.currentVersionNumber);

    function handlePin(versionNumber: number | null) {
        pin.mutate(
            { id: agent.id, versionNumber },
            {
                onSuccess: () => {
                    toast.success(versionNumber === null ? 'Now tracking the latest approved version' : `Pinned to v${versionNumber}`);
                    setPicked('');
                    onChanged();
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not update the version pin.'),
            },
        );
    }

    return (
        <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={`${uid}-title`} className="text-sm font-semibold">
                    Version pin
                </h3>
                <Badge variant={agent.pinnedVersionNumber != null ? 'default' : 'secondary'}>{currentLabel}</Badge>
            </div>
            {agent.templateLocked ? (
                <LockedHint />
            ) : versionsQuery.isPending ? (
                <Skeleton className="h-8 w-full" />
            ) : (
                <div className="flex flex-wrap items-center gap-2">
                    <NativeSelect
                        aria-label="Pin to version"
                        value={picked}
                        onChange={(event) => setPicked(event.target.value)}
                        className="h-8 w-32 text-xs"
                        disabled={pin.isPending}
                    >
                        <NativeSelectOption value="">Choose version&hellip;</NativeSelectOption>
                        {versions.map((version) => (
                            <NativeSelectOption key={version.id} value={String(version.versionNumber)}>
                                v{version.versionNumber}
                            </NativeSelectOption>
                        ))}
                    </NativeSelect>
                    <Button type="button" size="sm" disabled={!picked || pin.isPending} onClick={() => handlePin(Number(picked))}>
                        {pin.isPending ? <Spinner /> : null}
                        Pin
                    </Button>
                    {agent.pinnedVersionNumber != null ? (
                        <Button type="button" variant="outline" size="sm" disabled={pin.isPending} onClick={() => handlePin(null)}>
                            Track latest approved
                        </Button>
                    ) : null}
                </div>
            )}
        </Card>
    );
}

export function DepartmentAgentDetailDrawer({
    agentId,
    creating,
    departmentLabel,
    onOpenChange,
    onCreated,
    onRequestDelete,
    onSetDefault,
}: {
    agentId: string | null;
    creating: boolean;
    departmentLabel: string | null;
    onOpenChange: (open: boolean) => void;
    onCreated: (agent: DepartmentAgent) => void;
    onRequestDelete: (agent: DepartmentAgent) => void;
    onSetDefault: (agent: DepartmentAgent) => void;
}) {
    const open = creating || agentId !== null;
    const [tab, setTab] = useAgentCatalogTab();
    const detail = useDepartmentAgent(agentId ?? '');
    const agent = agentId ? (detail.data?.data ?? null) : null;
    const etag = detail.data?.etag ?? null;
    const templateQuery = useTemplate(agent?.promptTemplateId ?? '');
    const boundTemplate = agent ? (templateQuery.data?.data ?? null) : null;

    if (creating) {
        return (
            <DetailDrawer open={open} onOpenChange={onOpenChange} size="lg" title="New agent">
                <CreateAgentForm onCreated={onCreated} onCancel={() => onOpenChange(false)} />
            </DetailDrawer>
        );
    }

    return (
        <Tabs value={tab} onValueChange={(next) => void setTab(next as AgentCatalogTab)}>
            <DetailDrawer
                open={open}
                onOpenChange={onOpenChange}
                size="lg"
                title={agent ? agent.name : 'Agent'}
                badges={
                    agent ? (
                        <>
                            {agent.isDefault ? <Badge>Default</Badge> : null}
                            {agent.templateLocked ? (
                                <Badge variant="outline" className="gap-1">
                                    <IconLock aria-hidden className="size-3" />
                                    Locked
                                </Badge>
                            ) : null}
                        </>
                    ) : null
                }
                meta={agent ? <AgentMeta agent={agent} departmentLabel={departmentLabel} templateName={boundTemplate?.name ?? null} /> : null}
                tabs={agent ? <CatalogTabsList /> : null}
                footer={
                    agent ? (
                        <>
                            {!agent.isDefault ? (
                                <Button variant="outline" size="sm" onClick={() => onSetDefault(agent)}>
                                    Set default
                                </Button>
                            ) : null}
                            {!agent.templateLocked ? (
                                <Button variant="destructive" size="sm" onClick={() => onRequestDelete(agent)}>
                                    <IconTrash aria-hidden />
                                    Delete
                                </Button>
                            ) : null}
                        </>
                    ) : null
                }
            >
                {!open ? null : detail.isPending ? (
                    <DetailSkeleton />
                ) : detail.error || !agent ? (
                    <ErrorState
                        error={detail.error ?? new GatewayError(404, 'This agent does not exist or is outside your access scope.')}
                        onRetry={() => void detail.refetch()}
                    />
                ) : (
                    <>
                        <TabsContent value="settings" className="mt-0">
                            <SettingsForm
                                key={`${agent.id}-${agent.updatedAt}`}
                                agent={agent}
                                etag={etag}
                                onSaved={() => void detail.refetch()}
                                onReload={() => void detail.refetch()}
                            />
                        </TabsContent>
                        <TabsContent value="version" className="mt-0">
                            <PinControl agent={agent} onChanged={() => void detail.refetch()} />
                        </TabsContent>
                        <TabsContent value="history" className="mt-0">
                            {boundTemplate ? <VersionsPanel template={boundTemplate} /> : <Skeleton className="h-40 w-full" />}
                        </TabsContent>
                    </>
                )}
            </DetailDrawer>
        </Tabs>
    );
}
