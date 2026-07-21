'use client';

import { useState } from 'react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { TableCell, TableRow } from '@arcaai/ui/components/shadcn/table';
import { toast } from 'sonner';
import { GatewayError } from '@/shared/api';
import { usePutRegistrySetting, useRegistrySetting } from '../api';
import type { SettingCatalogItem } from '../api/types';

/**
 * One editable `agentic.context.*` row.
 *
 * Reads its own value + ETag, because the registry lane is key-addressed and
 * every key carries its own version — there is no batch read that could supply
 * one precondition for the whole table.
 *
 * Conflict handling is the point of this component: a stale write is refused by
 * the gateway (412) and the row re-reads and tells the admin to retry, rather
 * than silently clobbering whoever edited first.
 */
export function AgenticContextRow({ item }: { item: SettingCatalogItem }) {
    const settingQuery = useRegistrySetting(item.key, true);
    const putSetting = usePutRegistrySetting();
    // `null` = untouched, so the row DERIVES its displayed value from the server
    // during render rather than syncing it in an effect. That keeps a background
    // refetch (or a post-conflict re-read) visible immediately without stomping
    // in-progress input, and avoids the cascading re-render an effect would cause.
    const [edited, setEdited] = useState<string | null>(null);

    const stored = settingQuery.data?.data;
    const etag = settingQuery.data?.etag ?? null;
    const serverValue = stored === undefined ? '' : String(stored.value ?? '');
    const draft = edited ?? serverValue;
    const dirty = edited !== null && edited !== serverValue;

    const isNumeric = item.dataType === 'number';

    const onSave = () => {
        const parsed = isNumeric ? Number(draft) : draft;
        if (isNumeric && !Number.isFinite(parsed as number)) {
            toast.error(`${item.key} expects a number.`);
            return;
        }
        putSetting.mutate(
            { key: item.key, value: parsed, etag },
            {
                onSuccess: () => {
                    setEdited(null);
                    toast.success(`${item.key} saved.`);
                },
                onError: (error) => {
                    // 412 = someone else edited between our read and this write;
                    // 428 = we had no precondition to send. Both are recoverable
                    // by re-reading, so do that for the admin rather than making
                    // them guess.
                    const status = error instanceof GatewayError ? error.status : undefined;
                    if (status === 412 || status === 428) {
                        // Drop the local edit and adopt whatever is now stored, so
                        // the admin re-applies against the winning value instead of
                        // re-submitting a write we already know is stale.
                        setEdited(null);
                        void settingQuery.refetch();
                        toast.error(`${item.key} was changed by someone else — reloaded the current value. Re-apply your edit.`);
                        return;
                    }
                    toast.error(`Could not save ${item.key}.`);
                },
            },
        );
    };

    return (
        <TableRow>
            <TableCell className="align-top">
                <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs font-medium">{item.key}</span>
                    {item.label ? <span className="text-xs">{item.label}</span> : null}
                    {item.description ? <span className="text-muted-foreground text-xs">{item.description}</span> : null}
                </div>
            </TableCell>
            <TableCell className="align-top">
                {settingQuery.isPending ? (
                    <Skeleton className="h-9 w-40" />
                ) : (
                    <div className="flex flex-col gap-1">
                        <Label htmlFor={`setting-${item.key}`} className="sr-only">
                            {item.label ?? item.key}
                        </Label>
                        <Input
                            id={`setting-${item.key}`}
                            className="h-9 w-40 font-mono text-xs"
                            inputMode={isNumeric ? 'numeric' : undefined}
                            value={draft}
                            onChange={(event) => setEdited(event.target.value)}
                            aria-describedby={`source-${item.key}`}
                        />
                    </div>
                )}
            </TableCell>
            <TableCell className="align-top">
                {settingQuery.isPending ? (
                    <Skeleton className="h-5 w-24 rounded-full" />
                ) : (
                    <div className="flex flex-wrap items-center gap-1" id={`source-${item.key}`}>
                        {/* Not colour alone: the text states the source. */}
                        <Badge variant={stored?.sourceScope === 'code-default' ? 'outline' : 'secondary'} className="font-mono text-[10px]">
                            {stored?.sourceScope ?? 'unknown'}
                        </Badge>
                        {stored?.version ? <span className="text-muted-foreground font-mono text-[10px]">v{stored.version}</span> : null}
                    </div>
                )}
            </TableCell>
            <TableCell className="align-top">
                <Button size="sm" variant="outline" disabled={!dirty || putSetting.isPending} onClick={onSave}>
                    {putSetting.isPending ? <Spinner /> : null}
                    Save
                </Button>
            </TableCell>
        </TableRow>
    );
}
