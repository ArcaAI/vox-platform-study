'use client';

import { IconAdjustmentsCog } from '@tabler/icons-react';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useSettingsCatalog } from '../api';
import { AgenticContextRow } from './agentic-context-row';

const AGENTIC_CATEGORY = 'Agentic Context';

/**
 * The `agentic.*` settings registry (category "Agentic Context") — READ/WRITE
 * since TASK-533 B2.
 *
 * It was a metadata-only inventory that pointed elsewhere for editing, which
 * made the control plane decorative twice over: the values were not editable
 * here, and until B1 the running loop did not read them at all. Now each row
 * loads its own effective value + version and writes it back under optimistic
 * concurrency, and the live-documentation flush picks the change up on its next
 * flush with no redeploy.
 *
 * Per-row rather than one form: the registry lane is key-addressed and every key
 * carries its own version, so a single submit could not carry one precondition
 * for the whole table.
 */
export function AgenticContextTab() {
    const catalogQuery = useSettingsCatalog(true);

    if (catalogQuery.isPending) {
        return (
            <div className="flex flex-col gap-3" aria-hidden>
                <Skeleton className="h-5 w-72" />
                <div className="flex flex-col gap-2 rounded-md border p-3">
                    {Array.from({ length: 5 }, (_, index) => (
                        <Skeleton key={index} className="h-8 w-full" />
                    ))}
                </div>
            </div>
        );
    }
    if (catalogQuery.error || !catalogQuery.data) {
        return <ErrorState error={catalogQuery.error} onRetry={() => void catalogQuery.refetch()} />;
    }

    const items = catalogQuery.data.items.filter((item) => item.category === AGENTIC_CATEGORY);

    if (items.length === 0) {
        return (
            <EmptyState
                icon={IconAdjustmentsCog}
                title="No agentic context settings"
                description="The settings registry exposes no keys in the Agentic Context category for your role."
            />
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">
                {items.length} setting{items.length === 1 ? '' : 's'} in the <span className="font-mono text-xs">agentic.*</span> namespace. Edits are
                global-admin only and apply to the running documentation loop on its next flush — no redeploy. A concurrent edit is refused rather
                than overwritten.
            </p>
            <div className="rounded-md border">
                <Table aria-label="Agentic context settings catalog">
                    <TableHeader>
                        <TableRow>
                            <TableHead className="font-mono text-xs">Key</TableHead>
                            <TableHead className="font-mono text-xs">Value</TableHead>
                            <TableHead className="font-mono text-xs">Source</TableHead>
                            <TableHead className="sr-only">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {items.map((item) => (
                            <AgenticContextRow key={item.key} item={item} />
                        ))}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}
