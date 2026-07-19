'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { UseMutationResult } from '@tanstack/react-query';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { GatewayError } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import type { AgenticPolicy, UpdateAgenticPolicyRequest } from '../api';
import { buildSparsePatch, knobDraftValue, KNOB_GROUPS, type KnobField } from './agentic-knobs';

export type AgenticPolicyMutation = UseMutationResult<
    WithEtag<AgenticPolicy>,
    Error,
    { patch: UpdateAgenticPolicyRequest; etag: string | null }
>;

function isOccError(error: unknown): boolean {
    return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

function KnobEditor({
    id,
    field,
    value,
    onChange,
}: {
    id: string;
    field: KnobField;
    value: string | boolean;
    onChange: (value: string | boolean) => void;
}) {
    if (field.kind === 'switch') {
        return (
            <div className="flex items-center gap-2">
                <Switch id={id} checked={Boolean(value)} onCheckedChange={onChange} />
                <span className="text-muted-foreground font-mono text-xs">{value ? 'enabled' : 'disabled'}</span>
            </div>
        );
    }
    if (field.kind === 'tristate') {
        return (
            <NativeSelect id={id} value={String(value)} onChange={(event) => onChange(event.target.value)} className="h-8 text-xs">
                <NativeSelectOption value="default">Default (inherit)</NativeSelectOption>
                <NativeSelectOption value="on">Enabled</NativeSelectOption>
                <NativeSelectOption value="off">Disabled</NativeSelectOption>
            </NativeSelect>
        );
    }
    return (
        <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={String(value)}
            onChange={(event) => onChange(event.target.value)}
            className="h-8 font-mono text-xs"
            placeholder={field.kind === 'nullable-integer' ? 'default' : undefined}
        />
    );
}

/**
 * OCC save panel for the SYSTEM-tenant GLOBAL-DEFAULT policy: a sparse-patch
 * editor over the agentic-loop knobs + kill-switches. Saves send If-Match from
 * the read ETag; a 412 keeps local drafts and offers reload-merge (frame 08).
 */
export function AgenticPolicyForm({
    policy,
    etag,
    mutation,
    onReloadLatest,
}: {
    policy: AgenticPolicy;
    etag: string | null;
    mutation: AgenticPolicyMutation;
    onReloadLatest: () => void;
}) {
    const uid = useId();
    const [drafts, setDrafts] = useState<Record<string, string | boolean>>({});
    const [reason, setReason] = useState('');

    const patch = buildSparsePatch(policy, drafts);
    const dirty = Object.keys(patch).length > 0;

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!dirty) return;
        const trimmedReason = reason.trim();
        mutation.mutate(
            { patch: trimmedReason ? { ...patch, reason: trimmedReason } : patch, etag },
            {
                onSuccess: () => {
                    toast.success('Global agentic policy saved');
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
        // noValidate: integer drafts are parsed here; the gateway DTO validates ranges.
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4" aria-label="Agentic policy save panel">
            <div className="grid gap-4 lg:grid-cols-2">
                {KNOB_GROUPS.map((group) => (
                    <Card key={group.title} className="gap-3 p-4">
                        <div className="flex flex-col gap-1">
                            <h3 className="text-sm font-semibold">{group.title}</h3>
                            <p className="text-muted-foreground text-xs">{group.description}</p>
                        </div>
                        <div className="flex flex-col gap-3">
                            {group.fields.map((field) => {
                                const id = `${uid}-${field.key}`;
                                const value = drafts[field.key] ?? knobDraftValue(field, policy);
                                return (
                                    <div key={field.key} className="flex flex-col gap-1.5">
                                        <Label htmlFor={id} className="text-muted-foreground text-xs font-medium">
                                            {field.label}
                                        </Label>
                                        <KnobEditor
                                            id={id}
                                            field={field}
                                            value={value}
                                            onChange={(next) => setDrafts((current) => ({ ...current, [field.key]: next }))}
                                        />
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
