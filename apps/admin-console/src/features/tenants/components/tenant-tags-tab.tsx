'use client';

import { useState, type FormEvent } from 'react';
import { IconPlus, IconX } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ErrorState } from '@/shared/state/error-state';
import { useSetTenantTags, useTenantTags } from '../api/hooks';

/** Frame 12.1 tags tab: chip editor — each add/remove PUTs the full set. */
export function TenantTagsTab({ id }: { id: string }) {
    const { data, isLoading, error, refetch } = useTenantTags(id);
    const setTags = useSetTenantTags();
    const [draft, setDraft] = useState('');

    if (isLoading) {
        return (
            <Card className="flex flex-row flex-wrap gap-2 p-6">
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-32 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
            </Card>
        );
    }
    if (error || !data) {
        return <ErrorState error={error} onRetry={() => refetch()} />;
    }

    const tags = data.tags;

    function apply(next: string[], successMessage: string) {
        setTags.mutate(
            { id, tags: next },
            {
                onSuccess: () => toast.success(successMessage),
                onError: (mutationError) =>
                    toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not update the tags.'),
            },
        );
    }

    function handleAdd(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const value = draft.trim();
        if (!value || tags.includes(value)) return;
        apply([...tags, value], 'Tag added');
        setDraft('');
    }

    return (
        <Card className="gap-4 p-6">
            <div className="flex flex-wrap items-center gap-2">
                {tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                        {tag}
                        <button
                            type="button"
                            aria-label={`Remove tag ${tag}`}
                            className="hover:bg-foreground/10 cursor-pointer rounded-full p-0.5"
                            disabled={setTags.isPending}
                            onClick={() => apply(tags.filter((existing) => existing !== tag), 'Tag removed')}
                        >
                            <IconX aria-hidden className="size-3" />
                        </button>
                    </Badge>
                ))}
                {tags.length === 0 ? <span className="text-muted-foreground text-sm">No tags yet.</span> : null}
            </div>
            <form onSubmit={handleAdd} className="flex items-end gap-2">
                <div className="flex flex-col gap-2">
                    <Label htmlFor="tenant-new-tag">New tag</Label>
                    <Input
                        id="tenant-new-tag"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder="e.g. pilot"
                        autoComplete="off"
                        className="w-56"
                    />
                </div>
                <Button type="submit" variant="outline" aria-label="Add tag" disabled={!draft.trim() || setTags.isPending}>
                    <IconPlus aria-hidden />
                    Add
                </Button>
            </form>
        </Card>
    );
}
