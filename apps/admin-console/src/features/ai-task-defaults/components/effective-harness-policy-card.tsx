'use client';

import { useId } from 'react';
import { IconExternalLink } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ErrorState } from '@/shared/state/error-state';
import { useHarnessPolicySummary } from '../api/harness-policy-summary-hooks';
import { HARNESS_POLICY_FIELD_CONTROLS, harnessPolicyFieldDisplayValue } from '../api/harness-policy-summary-types';

/** Rule 10: skeleton shaped like the loaded table (one row per known field). */
function TableSkeleton() {
    return (
        <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-8 w-full" />
            {HARNESS_POLICY_FIELD_CONTROLS.map((field) => (
                <div key={field.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-4">
                    <Skeleton className="h-4 w-40 max-w-full" />
                    <Skeleton className="h-4 w-24 max-w-full" />
                    <Skeleton className="h-5 w-24 rounded-full" />
                </div>
            ))}
        </div>
    );
}

/**
 * Read-only "effective harness policy" summary (TASK-547 requirement 4 —
 * OD-2). One `GET admin/harness/policy` round-trip; every runtime knob
 * labeled with WHO controls it. `/harness/policy` owns the WRITE (rule 13's
 * one-authoritative-editor pattern) — this card is visibility only, so there
 * is no editor, no save button, and no "customize" affordance here.
 */
export function EffectiveHarnessPolicyCard() {
    const uid = useId();
    const query = useHarnessPolicySummary();

    if (query.isPending) return <TableSkeleton />;
    if (query.error || !query.data) {
        return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    }

    const policy = query.data;

    return (
        <section aria-labelledby={`${uid}-title`} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
                <h2 id={`${uid}-title`} className="text-base font-semibold">
                    Effective harness policy ({HARNESS_POLICY_FIELD_CONTROLS.length})
                </h2>
                <p className="text-muted-foreground text-sm">
                    The clinical-loop safety and generation knobs that govern this tenant, resolved from{' '}
                    <span className="font-mono text-xs">{policy.source}</span>, and who controls each one. Read-only — tenant-controlled values are
                    edited from Harness Policy.
                </p>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full min-w-2xl border-collapse text-left">
                    <caption className="sr-only">Effective harness policy value per setting, with who controls it</caption>
                    <thead>
                        <tr className="border-border text-muted-foreground border-b text-xs">
                            <th scope="col" className="py-2 pr-4 font-medium">
                                Setting
                            </th>
                            <th scope="col" className="py-2 pr-4 font-medium">
                                Effective value
                            </th>
                            <th scope="col" className="py-2 font-medium">
                                Controlled by
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {HARNESS_POLICY_FIELD_CONTROLS.map((field) => (
                            <tr key={field.key} className="border-border/60 border-b last:border-b-0">
                                <th scope="row" className="py-2 pr-4 text-left align-top text-sm font-normal">
                                    {field.label}
                                </th>
                                <td className="py-2 pr-4 align-top font-mono text-xs">{harnessPolicyFieldDisplayValue(policy, field)}</td>
                                <td className="py-2 align-top">
                                    <Badge variant={field.controlledBy === 'tenant' ? 'default' : 'secondary'}>
                                        {field.controlledBy === 'tenant' ? 'tenant' : 'global admin'}
                                    </Badge>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="flex justify-end">
                {/* Plain href, not a cross-feature import (rule 13 isolation) — `harness-policy` owns the write. */}
                <Button variant="outline" size="sm" asChild>
                    <a href="/harness/policy">
                        <IconExternalLink aria-hidden />
                        Edit tenant-controlled values in Harness Policy
                    </a>
                </Button>
            </div>
        </section>
    );
}
