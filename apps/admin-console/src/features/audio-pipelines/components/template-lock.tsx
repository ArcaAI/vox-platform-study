'use client';

import { useState, type FormEvent } from 'react';
import { IconCopy, IconLock } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { useClonePipeline } from '../api';
import type { Pipeline } from '../api';

/**
 * TASK-531 — the gateway's refusal text for a locked copy, mirrored here as the
 * visible reason on the disabled/absent edit controls (rule 11 §5: a disabled
 * control needs a stated reason). Kept identical to
 * `TEMPLATE_LOCKED_MESSAGE` in `pipeline.service.ts`.
 */
export const TEMPLATE_LOCKED_REASON = 'Template copies are read-only — clone to customize';

/**
 * Marks a pipeline row as a locked SYSTEM template copy.
 *
 * `variant="outline"` = neutral per rule 11 §7 — being a template is a
 * classification, not a health signal. The lock icon pairs with the text so the
 * meaning never rests on color alone (WCAG 1.4.1).
 */
export function TemplateBadge({ className }: { className?: string }) {
    return (
        <Badge variant="outline" className={className}>
            <IconLock aria-hidden className="size-3" />
            Template
        </Badge>
    );
}

/** Suggested identity for a copy of `source` — "<name> copy" / "<slug>-copy". */
function suggestCopyIdentity(source: Pipeline) {
    return { name: `${source.name} copy`, slug: `${source.slug}-copy` };
}

/**
 * Clone dialog — a SHORT form (name + slug only), which is why it stays a
 * Dialog rather than the DetailDrawer (rule 11 §1: dialogs are for short
 * confirmations and small forms). Everything else about the copy — config YAML,
 * description, tags — is inherited from the source server-side.
 */
export function ClonePipelineDialog({
    source,
    open,
    onOpenChange,
    onCloned,
}: {
    source: Pipeline | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Lets the caller select the new copy once it exists. */
    onCloned?: (clone: Pipeline) => void;
}) {
    const clone = useClonePipeline();
    const [form, setForm] = useState<{ name: string; slug: string } | null>(null);

    // Prefill from the source the first time the dialog opens for it.
    const values = form ?? (source ? suggestCopyIdentity(source) : { name: '', slug: '' });

    function close(next: boolean) {
        if (!next) setForm(null);
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!source) return;
        clone.mutate(
            { id: source.id, body: { name: values.name.trim(), slug: values.slug.trim() } },
            {
                onSuccess: (created) => {
                    toast.success(`Created ${created.name} — you can edit this copy`);
                    setForm(null);
                    onOpenChange(false);
                    onCloned?.(created);
                },
                onError: (error) =>
                    toast.error(error instanceof GatewayError ? error.message : 'Could not clone the pipeline.'),
            },
        );
    }

    const ready = values.name.trim().length > 0 && values.slug.trim().length > 0;

    return (
        <Dialog open={open} onOpenChange={close}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Clone pipeline</DialogTitle>
                    <DialogDescription>
                        {source?.templateLocked
                            ? 'Template copies are read-only. Cloning gives you an editable pipeline that starts from this configuration.'
                            : 'Creates an editable copy that starts from this pipeline’s current configuration.'}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="clone-pipeline-name">
                            Name
                            <span aria-hidden className="text-destructive">
                                *
                            </span>
                        </Label>
                        <Input
                            id="clone-pipeline-name"
                            value={values.name}
                            onChange={(event) => setForm({ ...values, name: event.target.value })}
                            required
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="clone-pipeline-slug">
                            Slug
                            <span aria-hidden className="text-destructive">
                                *
                            </span>
                        </Label>
                        <Input
                            id="clone-pipeline-slug"
                            value={values.slug}
                            onChange={(event) => setForm({ ...values, slug: event.target.value })}
                            className="font-mono"
                            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"
                            title="Lowercase alphanumeric with hyphens"
                            required
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => close(false)} disabled={clone.isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!ready || clone.isPending}>
                            {clone.isPending ? <Spinner /> : <IconCopy aria-hidden />}
                            Clone pipeline
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
