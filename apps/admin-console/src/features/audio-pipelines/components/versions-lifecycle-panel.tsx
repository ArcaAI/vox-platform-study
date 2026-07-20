'use client';

import { useState, type FormEvent } from 'react';
import { IconArrowsExchange, IconCopy, IconPower, IconStar, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { formatDateTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { useAssignPipelineTenant, useDeletePipeline, usePipelineVersions, useSetDefaultPipeline, useTogglePipeline } from '../api';
import type { Pipeline } from '../api';
import { TEMPLATE_LOCKED_REASON } from './template-lock';

function toastGatewayError(error: unknown, fallback: string) {
    toast.error(error instanceof GatewayError ? error.message : fallback);
}

/**
 * Versions tab of the pipeline detail drawer — the config-snapshot history
 * (GET :id/versions), newest first, one row per YAML change.
 */
export function PipelineVersionsTab({ pipelineId }: { pipelineId: string }) {
    const versions = usePipelineVersions(pipelineId);

    return (
        <section aria-label="Versions" className="flex flex-col gap-2">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Versions <span aria-hidden className="font-mono normal-case">{'·'} GET :id/versions</span>
            </h3>
            {versions.isPending ? (
                <div className="flex flex-col gap-2">
                    {Array.from({ length: 3 }, (_, index) => (
                        <Skeleton key={index} className="h-4 w-full" />
                    ))}
                </div>
            ) : versions.isError ? (
                <p role="alert" className="text-destructive text-sm">
                    {'Couldn’t load the version history.'}
                </p>
            ) : versions.data.length === 0 ? (
                <p className="text-muted-foreground text-sm">No config versions yet — snapshots appear after the first YAML change.</p>
            ) : (
                <ul aria-label="Config versions" className="flex flex-col">
                    {versions.data.map((version, index) => (
                        <li key={version.id} className="flex items-baseline gap-2 border-b py-1.5 text-sm last:border-0">
                            <span className="font-mono text-xs">v{version.versionNumber}</span>
                            <span className="text-muted-foreground text-xs">{formatDateTime(version.createdAt, 'date')}</span>
                            {index === 0 ? <span className="text-primary text-xs font-medium">current</span> : null}
                            {version.changeReason ? (
                                <span className="text-muted-foreground min-w-0 truncate text-xs" title={version.changeReason}>
                                    {version.changeReason}
                                </span>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/** Elevated-only cross-tenant assign (frame 34: "cross-tenant assign = global admin"). */
function AssignTenantDialog({
    pipeline,
    open,
    onOpenChange,
}: {
    pipeline: Pipeline;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const assign = useAssignPipelineTenant();
    const [tenantId, setTenantId] = useState('');

    function handleOpenChange(next: boolean) {
        if (!next) {
            setTenantId('');
            assign.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        assign.mutate(
            { id: pipeline.id, tenantId: tenantId.trim() },
            {
                onSuccess: (result) => {
                    toast.success(result.message);
                    handleOpenChange(false);
                },
                onError: (error) => toastGatewayError(error, 'Could not assign the pipeline.'),
            },
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Assign tenant</DialogTitle>
                    <DialogDescription>
                        Assigns <span className="font-mono">{pipeline.slug}</span> within its owning tenant and promotes it to the tenant
                        default. A cross-tenant transfer is rejected by the gateway.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="assign-tenant-id">
                            Tenant ID
                            <span aria-hidden className="text-destructive">
                                *
                            </span>
                        </Label>
                        <Input
                            id="assign-tenant-id"
                            value={tenantId}
                            onChange={(event) => setTenantId(event.target.value)}
                            placeholder="Tenant UUID"
                            className="font-mono"
                            required
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={assign.isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!tenantId.trim() || assign.isPending}>
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
 * Lifecycle tab of the pipeline detail drawer — set default (POST + confirm),
 * enable/disable toggle (If-Match PATCH), assign tenant (elevated-only) and the
 * type-to-confirm delete.
 */
export function PipelineLifecycleTab({
    detail,
    isElevated,
    onReload,
    onDeleted,
    onClone,
}: {
    detail: WithEtag<Pipeline>;
    /** Gates the cross-tenant assign action (frame 34: global-admin-only). */
    isElevated: boolean;
    /** Refetches the detail after a toggle 412 (fresh ETag). */
    onReload: () => void;
    /** Clears the grid selection / closes the drawer after a successful delete. */
    onDeleted: () => void;
    /** TASK-531 — opens the clone dialog; replaces Delete on a locked copy. */
    onClone?: () => void;
}) {
    const setDefault = useSetDefaultPipeline();
    const toggle = useTogglePipeline();
    const remove = useDeletePipeline();
    const [confirming, setConfirming] = useState<'default' | 'delete' | null>(null);
    const [assignOpen, setAssignOpen] = useState(false);

    const pipeline = detail.data;
    const enabled = pipeline.resourceStatus === 'ENABLED';

    function handleSetDefault() {
        setDefault.mutate(pipeline.id, {
            onSuccess: () => {
                toast.success(`${pipeline.name} is now the tenant default`);
                setConfirming(null);
            },
            onError: (error) => {
                toastGatewayError(error, 'Could not set the default pipeline.');
                setConfirming(null);
            },
        });
    }

    function handleToggle() {
        if (!detail.etag) return;
        const next = pipeline.resourceStatus !== 'ENABLED';
        toggle.mutate(
            { id: pipeline.id, enabled: next, etag: detail.etag },
            {
                onSuccess: () => toast.success(`${pipeline.name} ${next ? 'enabled' : 'disabled'}`),
                onError: (error) => {
                    if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
                    toastGatewayError(error, 'Could not toggle the pipeline.');
                },
            },
        );
    }

    function handleDelete() {
        remove.mutate(pipeline.id, {
            onSuccess: () => {
                toast.success(`${pipeline.name} deleted`);
                setConfirming(null);
                onDeleted();
            },
            onError: (error) => {
                toastGatewayError(error, 'Could not delete the pipeline.');
                setConfirming(null);
            },
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <OccConflictAlert
                error={toggle.error}
                onReload={() => {
                    toggle.reset();
                    onReload();
                }}
            />
            <section aria-label="Lifecycle" className="flex flex-col gap-2">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Lifecycle</h3>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" disabled={pipeline.isDefault || setDefault.isPending} onClick={() => setConfirming('default')}>
                        <IconStar aria-hidden />
                        {pipeline.isDefault ? 'Tenant default' : 'Set default'}
                    </Button>
                    <Button variant="outline" size="sm" disabled={toggle.isPending || !detail.etag} onClick={handleToggle}>
                        {toggle.isPending ? <Spinner /> : <IconPower aria-hidden />}
                        {enabled ? 'Disable' : 'Enable'}
                    </Button>
                    {isElevated ? (
                        <Button variant="outline" size="sm" onClick={() => setAssignOpen(true)}>
                            <IconArrowsExchange aria-hidden />
                            Assign tenant
                        </Button>
                    ) : null}
                    {/* TASK-531 — set-default and enable/disable stay available on a
                        locked template copy (OD-1); only Delete is withheld, since the
                        gateway answers it with 403. Clone is offered in its place. */}
                    {pipeline.templateLocked ? (
                        <Button variant="outline" size="sm" onClick={onClone}>
                            <IconCopy aria-hidden />
                            Clone to customize
                        </Button>
                    ) : (
                        <Button variant="destructive" size="sm" onClick={() => setConfirming('delete')}>
                            <IconTrash aria-hidden />
                            Delete
                        </Button>
                    )}
                </div>
                {pipeline.templateLocked ? (
                    <p className="text-muted-foreground text-sm">{TEMPLATE_LOCKED_REASON}</p>
                ) : null}
            </section>

            <ConfirmDialog
                open={confirming === 'default'}
                onOpenChange={(open) => !open && setConfirming(null)}
                title={`Set ${pipeline.name} as the tenant default?`}
                description="The previous default is unset atomically. New SDK sessions without an explicit pipeline pick the default."
                confirmLabel="Set default"
                isPending={setDefault.isPending}
                onConfirm={handleSetDefault}
            />
            <ConfirmDialog
                open={confirming === 'delete'}
                onOpenChange={(open) => !open && setConfirming(null)}
                title={`Delete ${pipeline.name}?`}
                description="The pipeline is removed from the tenant and SDK pickers. This cannot be undone from the console."
                confirmLabel="Delete pipeline"
                destructive
                typeToConfirm={pipeline.slug}
                isPending={remove.isPending}
                onConfirm={handleDelete}
            />
            <AssignTenantDialog pipeline={pipeline} open={assignOpen} onOpenChange={setAssignOpen} />
        </div>
    );
}
