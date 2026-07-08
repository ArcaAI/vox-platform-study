'use client';

import { useId, useState } from 'react';
import { IconChecklist, IconCircleCheck, IconDeviceFloppy } from '@tabler/icons-react';
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
}: {
    /** Detail read (ETag included) of the selected pipeline. */
    detail: WithEtag<Pipeline>;
    /** Refetches the detail after a 412 so a fresh ETag backs the next save. */
    onReload: () => void;
}) {
    const textareaId = useId();
    const [draft, setDraft] = useState<string | null>(null);
    const validate = useValidatePipelineConfig();
    const update = useUpdatePipeline();

    const pipeline = detail.data;
    const value = draft ?? pipeline.configYaml ?? '';
    const dirty = draft !== null && draft !== pipeline.configYaml;

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
            <div className="flex flex-col gap-2">
                <Label htmlFor={textareaId}>
                    Config YAML {'·'} <span className="font-mono text-xs font-normal">{pipeline.slug}</span>
                </Label>
                <Textarea
                    id={textareaId}
                    value={value}
                    onChange={(event) => setDraft(event.target.value)}
                    spellCheck={false}
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
                <Button onClick={handleSave} disabled={!dirty || update.isPending}>
                    {update.isPending ? <Spinner /> : <IconDeviceFloppy aria-hidden />}
                    Save
                </Button>
                <span className="text-muted-foreground font-mono text-xs">POST validate {'·'} PATCH :id (If-Match)</span>
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
