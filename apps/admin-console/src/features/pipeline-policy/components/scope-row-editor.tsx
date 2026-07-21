'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconX } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { ToggleGroup, ToggleGroupItem } from '@arcaai/ui/components/shadcn/toggle-group';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { usePutPipelinePolicyRow, type PipelinePolicyRow, type PipelinePolicyScope, type PipelineToggleKey, type UpdatePipelinePolicyRequest } from '../api';
import {
    GLOBAL_ONLY_TOGGLE_HINT,
    GLOBAL_ONLY_TOGGLE_KEYS,
    pinToTri,
    previewResolution,
    toggleLabel,
    TOGGLE_COLUMNS,
    triOptionLabel,
    triToPin,
    type CascadeRows,
    type TriState,
} from './cascade';

const TRI_STATES: TriState[] = ['inherit', 'on', 'off'];

function isOccError(error: unknown): boolean {
    return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/**
 * Effective preview + row editor panel (frame 39 panel c): tri-state pins
 * (inherit / on / off) for ONE scope row, a WORM change note, a pre-save
 * preview recompute, and the OCC PUT (If-Match; 412 keeps drafts and offers
 * reload-merge). `harnessEnabled` cannot be pinned at DOCTOR — the service
 * enforces the registered max scope (DEPARTMENT) with a 400.
 */
export function ScopeRowEditor({
    scope,
    scopeId,
    scopeLabel,
    row,
    etag,
    rows,
    previewSubject,
    context,
    onReloadLatest,
    onClose,
    isElevated,
}: {
    scope: PipelinePolicyScope;
    scopeId: string | null;
    scopeLabel: string;
    row: PipelinePolicyRow;
    etag: string | null;
    rows: CascadeRows;
    previewSubject: string;
    context: { department: string | null; doctor: string | null };
    /**
     * GLOBAL_ADMIN callers may write the governed toggles
     * (`harnessEnabled`, `autoNerEnabled`); everyone else sees them read-only,
     * because `PipelinePolicyService.upsertRow` 403s on those keys for a
     * non-elevated caller. The server remains the authority — this only avoids
     * offering a control that cannot succeed.
     */
    isElevated: boolean;
    onReloadLatest: () => void;
    onClose: () => void;
}) {
    const uid = useId();
    const mutation = usePutPipelinePolicyRow();
    // Sparse overrides on top of the loaded row, so a reload after a 412
    // keeps the drafts (frame 08 reload-merge) and re-applies them.
    const [drafts, setDrafts] = useState<Partial<Record<PipelineToggleKey, TriState>>>({});
    const [reason, setReason] = useState('');

    const triFor = (key: PipelineToggleKey): TriState => drafts[key] ?? pinToTri(row[key]);
    const changedKeys = TOGGLE_COLUMNS.map(({ key }) => key).filter((key) => triFor(key) !== pinToTri(row[key]));
    const dirty = changedKeys.length > 0;

    const draftPins = Object.fromEntries(TOGGLE_COLUMNS.map(({ key }) => [key, triToPin(triFor(key))])) as Record<
        PipelineToggleKey,
        boolean | null
    >;
    const preview = previewResolution(draftPins, scope, rows, context);

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!dirty) return;
        const body: UpdatePipelinePolicyRequest = {};
        for (const key of changedKeys) body[key] = triToPin(triFor(key));
        const trimmedReason = reason.trim();
        if (trimmedReason) body.reason = trimmedReason;
        mutation.mutate(
            { scope, scopeId, body, etag },
            {
                onSuccess: () => {
                    toast.success(`Scope row saved (${scopeLabel})`);
                    setDrafts({});
                    setReason('');
                },
                onError: (error) => {
                    // OCC conflicts render the inline alert instead.
                    if (!isOccError(error)) toast.error(error.message);
                },
            },
        );
    }

    return (
        <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
            <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                    <h2 id={`${uid}-title`} className="text-sm font-semibold">
                        Effective preview &middot; PUT row
                    </h2>
                    <p className="text-muted-foreground font-mono text-xs">
                        {scopeLabel} &middot; v{row.version}
                    </p>
                </div>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Close editor" onClick={onClose}>
                    <IconX aria-hidden />
                </Button>
            </div>

            <div className="flex flex-col gap-1" aria-label={`Preview for ${previewSubject}`}>
                <p className="text-muted-foreground text-xs">Preview for: {previewSubject}</p>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
                    {preview.map((line) => (
                        <div key={line.column.key} className="col-span-2 grid grid-cols-subgrid">
                            <dt className="text-muted-foreground font-mono text-xs">{line.column.param}</dt>
                            <dd className="font-mono text-xs">
                                {toggleLabel(line.column.key, line.value)} ({line.from})
                            </dd>
                        </div>
                    ))}
                </dl>
                <p className="text-muted-foreground text-xs">Preview recomputes before save &mdash; nearest defined scope wins.</p>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-3" aria-label={`Edit ${scopeLabel} scope row`}>
                {TOGGLE_COLUMNS.map((column) => {
                    // harnessEnabled has a registered max scope of DEPARTMENT.
                    const beyondMaxScope = column.key === 'harnessEnabled' && scope === 'DOCTOR';
                    // Governed toggles are global-admin-only.
                    const globalOnly = GLOBAL_ONLY_TOGGLE_KEYS.includes(column.key) && !isElevated;
                    return (
                        <div key={column.key} className="flex flex-col gap-1.5">
                            <span className="text-muted-foreground text-xs font-medium">{column.label}</span>
                            <ToggleGroup
                                type="single"
                                variant="outline"
                                size="sm"
                                aria-label={column.label}
                                value={triFor(column.key)}
                                onValueChange={(next) => {
                                    // Radix reports '' when the active item is re-clicked; a pin always has a state.
                                    if (next) setDrafts((current) => ({ ...current, [column.key]: next as TriState }));
                                }}
                                disabled={beyondMaxScope || globalOnly}
                            >
                                {TRI_STATES.map((tri) => (
                                    <ToggleGroupItem key={tri} value={tri} className="font-mono text-xs">
                                        {triOptionLabel(column.key, tri)}
                                    </ToggleGroupItem>
                                ))}
                            </ToggleGroup>
                            {beyondMaxScope ? (
                                <p className="text-muted-foreground text-xs">Routing cannot be pinned per-doctor (max scope DEPARTMENT).</p>
                            ) : null}
                            {globalOnly ? <p className="text-muted-foreground text-xs">{GLOBAL_ONLY_TOGGLE_HINT}</p> : null}
                        </div>
                    );
                })}

                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${uid}-reason`} className="text-muted-foreground text-xs font-medium">
                        Reason
                    </Label>
                    <Input
                        id={`${uid}-reason`}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        maxLength={500}
                        placeholder={'Why this edit\u2026'}
                    />
                    <p className="text-muted-foreground text-xs">Every PUT appends a PipelinePolicyChange WORM row.</p>
                </div>

                <OccConflictAlert
                    error={mutation.error}
                    onReload={() => {
                        mutation.reset();
                        onReloadLatest();
                    }}
                />

                <div className="flex flex-wrap items-center justify-end gap-3">
                    {dirty ? <span className="text-muted-foreground text-sm">Unsaved changes</span> : null}
                    <Button type="submit" disabled={!dirty || mutation.isPending}>
                        {mutation.isPending ? <Spinner /> : null}
                        Save row &middot; PUT
                    </Button>
                </div>
            </form>
        </Card>
    );
}
