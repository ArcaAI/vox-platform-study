'use client';

import { IconAdjustmentsCog } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useSettingsCatalog } from '../api';

const AGENTIC_CATEGORY = 'Agentic Context';

/**
 * Read-only inventory of the `agentic.*` settings registry (category
 * "Agentic Context"). The catalog is METADATA only (tier / scope /
 * sensitivity / editor) — never a value — so it is safe for any global admin
 * to read. Editing these rows lives on Settings & secrets; this tab documents
 * the surface and its governance without duplicating the OCC CRUD.
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
                {items.length} setting{items.length === 1 ? '' : 's'} in the <span className="font-mono text-xs">agentic.*</span> namespace. Values are
                edited on <span className="font-medium">Settings &amp; secrets</span>; this is the governance inventory (
                <span className="font-mono text-xs">GET /admin/settings/catalog</span>).
            </p>
            <div className="rounded-md border">
                <Table aria-label="Agentic context settings catalog">
                    <TableHeader>
                        <TableRow>
                            <TableHead className="font-mono text-xs">Key</TableHead>
                            <TableHead className="font-mono text-xs">Type</TableHead>
                            <TableHead className="font-mono text-xs">Scope</TableHead>
                            <TableHead className="font-mono text-xs">Editable by</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {items.map((item) => (
                            <TableRow key={item.key}>
                                <TableCell className="align-top">
                                    <div className="flex flex-col gap-0.5">
                                        <span className="font-mono text-xs font-medium">{item.key}</span>
                                        {item.label ? <span className="text-xs">{item.label}</span> : null}
                                        {item.description ? <span className="text-muted-foreground text-xs">{item.description}</span> : null}
                                    </div>
                                </TableCell>
                                <TableCell className="font-mono text-xs align-top">{item.dataType}</TableCell>
                                <TableCell className="align-top">
                                    <div className="flex flex-wrap gap-1">
                                        <Badge variant="secondary" className="font-mono text-[10px]">
                                            {item.maxScope}
                                        </Badge>
                                        {item.globalOnly ? (
                                            <Badge variant="outline" className="font-mono text-[10px]">
                                                global only
                                            </Badge>
                                        ) : null}
                                    </div>
                                </TableCell>
                                <TableCell className="font-mono text-xs align-top">{item.editableBy}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}
