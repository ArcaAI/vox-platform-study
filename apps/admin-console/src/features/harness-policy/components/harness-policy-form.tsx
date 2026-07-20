'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { UseMutationResult } from '@tanstack/react-query';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { GatewayError } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import type { HarnessPolicy, UpdateHarnessPolicyRequest } from '../api';
import { buildSparsePatch, fieldDraftValue, LOCKED_FIELD_HINT, POLICY_FIELD_GROUPS, type PolicyField } from './policy-fields';

export type PolicyMutation = UseMutationResult<WithEtag<HarnessPolicy>, Error, { patch: UpdateHarnessPolicyRequest; etag: string | null }>;

function isOccError(error: unknown): boolean {
    return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

function FieldEditor({
    id,
    field,
    value,
    onChange,
    disabled = false,
}: {
    id: string;
    field: PolicyField;
    value: string | boolean;
    onChange: (value: string | boolean) => void;
    disabled?: boolean;
}) {
    if (field.kind === 'switch') {
        return (
            <div className="flex items-center gap-2">
                <Switch id={id} checked={Boolean(value)} onCheckedChange={onChange} disabled={disabled} />
                <span className="text-muted-foreground font-mono text-xs">{value ? 'true' : 'false'}</span>
            </div>
        );
    }
    if (field.kind === 'fraction' || field.kind === 'integer') {
        return (
            <Input
                id={id}
                type="number"
                inputMode="decimal"
                min={0}
                max={field.kind === 'fraction' ? 1 : undefined}
                step={field.kind === 'fraction' ? 0.05 : 1}
                value={String(value)}
                onChange={(event) => onChange(event.target.value)}
                disabled={disabled}
                className="h-8 font-mono text-xs"
            />
        );
    }
    return (
        <Input id={id} value={String(value)} onChange={(event) => onChange(event.target.value)} disabled={disabled} className="h-8 font-mono text-xs" />
    );
}

/**
 * OCC save panel (frame 36): sparse-patch edit form over one policy row —
 * used by the Tenant policy tab (PATCH policy) and the Global default tab
 * (PATCH policy/global). Saves send If-Match from the read ETag; a 412 keeps
 * local drafts and offers reload-merge per frame 08.
 */
export function HarnessPolicyForm({
    policy,
    etag,
    mutation,
    onReloadLatest,
    successMessage,
    lockedKeys,
}: {
    policy: HarnessPolicy;
    etag: string | null;
    mutation: PolicyMutation;
    onReloadLatest: () => void;
    successMessage: string;
    /**
     * TASK-532 (E3-L1) — keys this editor renders read-only. The TENANT tab
     * passes `TENANT_LOCKED_POLICY_KEYS`; the GLOBAL tab passes nothing (it may
     * write every key). Locked fields are excluded from the sparse patch too, so
     * a stale draft can never smuggle one into a save.
     */
    lockedKeys?: readonly PolicyField['key'][];
}) {
    const uid = useId();
    const [drafts, setDrafts] = useState<Record<string, string | boolean>>({});
    const [reason, setReason] = useState('');

    const locked = new Set<string>(lockedKeys ?? []);
    const patch = buildSparsePatch(policy, drafts);
    for (const key of locked) delete (patch as Record<string, unknown>)[key];
    const dirty = Object.keys(patch).length > 0;

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!dirty) return;
        const trimmedReason = reason.trim();
        mutation.mutate(
            { patch: trimmedReason ? { ...patch, reason: trimmedReason } : patch, etag },
            {
                onSuccess: () => {
                    toast.success(successMessage);
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
        // noValidate: fractional steps trip float-modulo stepMismatch checks;
        // drafts are parsed here and the gateway DTO validates the ranges.
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4" aria-label="Policy save panel">
            <div className="grid gap-4 lg:grid-cols-2">
                {POLICY_FIELD_GROUPS.map((group) => (
                    <Card key={group.title} className="gap-3 p-4">
                        <h3 className="text-sm font-semibold">{group.title}</h3>
                        <div className="flex flex-col gap-3">
                            {group.fields.map((field) => {
                                const id = `${uid}-${field.key}`;
                                const value = drafts[field.key] ?? fieldDraftValue(field, policy);
                                const isLocked = locked.has(field.key);
                                return (
                                    <div key={field.key} className="flex flex-col gap-1.5">
                                        <Label htmlFor={id} className="text-muted-foreground text-xs font-medium">
                                            {field.label}
                                        </Label>
                                        <FieldEditor
                                            id={id}
                                            field={field}
                                            value={value}
                                            disabled={isLocked}
                                            onChange={(next) => setDrafts((current) => ({ ...current, [field.key]: next }))}
                                        />
                                        {isLocked ? <p className="text-muted-foreground text-xs">{LOCKED_FIELD_HINT}</p> : null}
                                        {field.hint ? <p className="text-muted-foreground text-xs">{field.hint}</p> : null}
                                    </div>
                                );
                            })}
                        </div>
                    </Card>
                ))}
                <Card className="gap-3 p-4">
                    <h3 className="text-sm font-semibold">Change note</h3>
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
                        <p className="text-muted-foreground text-xs">Recorded on the HarnessPolicyChange WORM row with the before/after snapshot.</p>
                    </div>
                </Card>
            </div>
            <OccConflictAlert
                error={mutation.error}
                onReload={() => {
                    // Drafts stay in memory (frame 08 reload-merge: no silent loss);
                    // re-saving applies them against the freshly loaded version.
                    mutation.reset();
                    onReloadLatest();
                }}
            />
            <div className="flex flex-wrap items-center justify-end gap-3">
                {dirty ? <span className="text-muted-foreground text-sm">Unsaved changes</span> : null}
                <Button type="submit" disabled={!dirty || mutation.isPending}>
                    {mutation.isPending ? <Spinner /> : null}
                    Save &middot; If-Match
                </Button>
            </div>
        </form>
    );
}
