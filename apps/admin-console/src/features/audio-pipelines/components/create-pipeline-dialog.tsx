'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { useCreatePipeline } from '../api';

const EMPTY_FORM = { name: '', slug: '', configYaml: '' };

/** Frame 34 "+ New pipeline" — POST /admin/audio/pipelines. */
export function CreatePipelineDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const create = useCreatePipeline();
    const [form, setForm] = useState(EMPTY_FORM);

    function handleOpenChange(next: boolean) {
        if (!next) {
            setForm(EMPTY_FORM);
            create.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        create.mutate(
            { name: form.name.trim(), slug: form.slug.trim(), configYaml: form.configYaml },
            {
                onSuccess: (pipeline) => {
                    toast.success(`Pipeline ${pipeline.name} created`);
                    handleOpenChange(false);
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the pipeline.'),
            },
        );
    }

    const ready = form.name.trim() && form.slug.trim() && form.configYaml.trim();

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-[50vw]">
                <DialogHeader>
                    <DialogTitle>New pipeline</DialogTitle>
                    <DialogDescription>
                        Creates an ASR pipeline for this tenant. Invalid YAML or a duplicate slug is rejected — use Validate in the config
                        editor to preflight changes later.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={create.isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!ready || create.isPending}>
                            {create.isPending ? <Spinner /> : null}
                            Create pipeline
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
