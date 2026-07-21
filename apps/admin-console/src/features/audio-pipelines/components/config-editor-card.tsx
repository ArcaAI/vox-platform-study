'use client';

import { useId, useState } from 'react';
import { IconChecklist, IconCircleCheck, IconCopy, IconDeviceFloppy, IconLock } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { useUpdatePipeline, useValidatePipelineConfig } from '../api';
import type { Pipeline } from '../api';
import { TEMPLATE_LOCKED_REASON } from './template-lock';

/**
 * Config tab of the pipeline detail drawer — the selected pipeline's YAML as an
 * editable mono buffer with a validate preflight (POST validate, result inline)
 * and an OCC-guarded save (PATCH If-Match; 412 keeps the local draft and offers
 * reload). The drawer mounts with key={pipelineId} so the draft resets per
 * selection.
 */
export function PipelineConfigTab({
    detail,
    onReload,
    onClone,
}: {
    /** Detail read (ETag included) of the selected pipeline. */
    detail: WithEtag<Pipeline>;
    /** Refetches the detail after a 412 so a fresh ETag backs the next save. */
    onReload: () => void;
    /** Opens the clone dialog for a locked template copy. */
    onClone?: () => void;
}) {
    const textareaId = useId();
    const lockedReasonId = useId();
    const [draft, setDraft] = useState<string | null>(null);
    const validate = useValidatePipelineConfig();
    const update = useUpdatePipeline();

    const pipeline = detail.data;
    const value = draft ?? pipeline.configYaml ?? '';
    const dirty = draft !== null && draft !== pipeline.configYaml;
    // A locked template copy renders VIEW-ONLY. We surface the lock
    // up front with a Clone affordance rather than letting the user type a full
    // config and only discover the 403 when they press Save.
    const locked = pipeline.templateLocked;

    function handleSave() {
        if (!detail.etag || draft === null) return;
        update.mutate(
            { id: pipeline.id, patch: { configYaml: draft }, etag: detail.etag },
            {
                onSuccess: () => {
                    toast.success('Pipeline config saved');
                    setDraft(null);
                },
                onError: (error) => {
                    // 412/428 render inline via OccConflictAlert; the rest toast.
                    if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
                    toast.error(error instanceof GatewayError ? error.message : 'Could not save the pipeline config.');
                },
            },
        );
    }

    return (
        <div className="flex flex-col gap-3">
            {locked ? (
                <div className="border-border bg-muted/40 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border p-3">
                    <p id={lockedReasonId} className="text-muted-foreground min-w-0 flex-1 text-sm">
                        <IconLock aria-hidden className="mr-1.5 inline size-4 align-text-bottom" />
                        {/* The constant carries no trailing stop (it must match the
                            gateway's 403 message verbatim), so punctuate here. */}
                        {TEMPLATE_LOCKED_REASON}.
                        {pipeline.sourceTemplateSlug ? (
                            <>
                                {' '}
                                Derived from <span className="font-mono text-xs">{pipeline.sourceTemplateSlug}</span>.
                            </>
                        ) : null}
                    </p>
                    {onClone ? (
                        <Button size="sm" onClick={onClone}>
                            <IconCopy aria-hidden />
                            Clone to customize
                        </Button>
                    ) : null}
                </div>
            ) : null}
            <div className="flex flex-col gap-2">
                <Label htmlFor={textareaId}>
                    Config YAML {'·'} <span className="font-mono text-xs font-normal">{pipeline.slug}</span>
                </Label>
                <Textarea
                    id={textareaId}
                    value={value}
                    onChange={(event) => setDraft(event.target.value)}
                    spellCheck={false}
                    readOnly={locked}
                    aria-describedby={locked ? lockedReasonId : undefined}
                    className="min-h-72 font-mono text-xs"
                />
            </div>
            <ValidateResult result={validate.data} error={validate.error} />
            <OccConflictAlert
                error={update.error}
                onReload={() => {
                    update.reset();
                    onReload();
                }}
            />
            <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => validate.mutate(value)} disabled={validate.isPending}>
                    {validate.isPending ? <Spinner /> : <IconChecklist aria-hidden />}
                    Validate
                </Button>
                {/* Save is absent (not merely disabled) on a locked copy — the
                    supported action there is Clone, offered above. */}
                {locked ? null : (
                    <Button onClick={handleSave} disabled={!dirty || update.isPending}>
                        {update.isPending ? <Spinner /> : <IconDeviceFloppy aria-hidden />}
                        Save
                    </Button>
                )}
                <span className="text-muted-foreground font-mono text-xs">
                    {locked ? 'POST validate · read-only copy' : 'POST validate · PATCH :id (If-Match)'}
                </span>
            </div>
        </div>
    );
}

/** Inline preflight verdict: success and failure both pair icon + text. */
function ValidateResult({ result, error }: { result: { valid: boolean; errors?: string[] } | undefined; error: unknown }) {
    if (error) {
        return (
            <p role="alert" className="text-destructive text-sm">
                Validate preflight unavailable{error instanceof GatewayError ? ` (${error.status})` : ''}. Try again.
            </p>
        );
    }
    if (!result) return null;
    if (result.valid) {
        return (
            <p className="text-success flex items-center gap-1.5 text-sm">
                <IconCircleCheck aria-hidden className="size-4" />
                Config is valid
            </p>
        );
    }
    return (
        <div role="alert" className="text-destructive flex flex-col gap-1 text-sm">
            <p className="font-medium">Config is invalid</p>
            <ul className="list-disc pl-5">
                {(result.errors ?? []).map((message, index) => (
                    <li key={index} className="font-mono text-xs">
                        {message}
                    </li>
                ))}
            </ul>
        </div>
    );
}
