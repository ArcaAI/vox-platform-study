'use client';

import { Fragment, useId, type ReactNode } from 'react';
import { IconBuilding } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useSession } from '@/shared/auth';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useAgenticInstructions, type AgenticInstructions } from '../api';

const POLICY_SOURCE_LABELS: Record<AgenticInstructions['policySource'], string> = {
    tenant: 'tenant row',
    'system-default': 'global default row',
    'code-default': 'code defaults',
};

/** Skeleton mirroring the four instruction sections (rule 10). */
function InstructionsSkeleton() {
    return (
        <div className="flex flex-col gap-4" aria-hidden>
            {Array.from({ length: 4 }, (_, index) => (
                <Card key={index} className="gap-3 p-4">
                    <Skeleton className="h-4 w-40" />
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-4/5" />
                        <Skeleton className="h-4 w-2/3" />
                    </div>
                </Card>
            ))}
        </div>
    );
}

/** Two-column key/value block shared by the tier / pin / threshold sections. */
function FieldList({ rows }: { rows: { label: string; value: ReactNode }[] }) {
    return (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            {rows.map((row) => (
                <Fragment key={row.label}>
                    <dt className="text-muted-foreground font-mono text-xs break-all">{row.label}</dt>
                    <dd className="min-w-0 font-mono text-xs break-all">{row.value}</dd>
                </Fragment>
            ))}
        </dl>
    );
}

function InstructionsDocument({ instructions }: { instructions: AgenticInstructions }) {
    const uid = useId();
    const { promptTier, judgePrompt, sensorThresholds, safetyCriteria } = instructions;

    return (
        <section className="flex flex-col gap-4" aria-labelledby={`${uid}-title`}>
            <div className="flex flex-wrap items-center gap-2">
                <h2 id={`${uid}-title`} className="text-sm font-semibold">
                    Agentic instruction set
                </h2>
                <Badge variant={instructions.policySource === 'tenant' ? 'default' : 'secondary'}>
                    {POLICY_SOURCE_LABELS[instructions.policySource]}
                </Badge>
            </div>
            <p className="text-muted-foreground text-xs">
                Read-only aggregate. The policy is edited on <span className="font-mono">/harness/policy</span>, prompts on{' '}
                <span className="font-mono">/agents</span>; the judge prompt is vendored and non-editable by license.
            </p>

            <div className="grid items-start gap-4 xl:grid-cols-2">
                <Card className="gap-3 p-4">
                    <h3 className="text-sm font-semibold">Resolved prompt tier</h3>
                    <FieldList
                        rows={[
                            { label: 'template', value: promptTier.template },
                            { label: 'promptId', value: promptTier.promptId },
                            { label: 'resolvedFrom', value: promptTier.resolvedFrom },
                            { label: 'departmentId', value: promptTier.departmentId ?? <span className="text-muted-foreground">tenant baseline</span> },
                            { label: 'promptType', value: promptTier.promptType },
                        ]}
                    />
                </Card>

                <Card className="gap-3 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">Judge prompt pin</h3>
                        <Badge variant="outline">{judgePrompt.editable ? 'editable' : 'vendored'}</Badge>
                    </div>
                    <FieldList
                        rows={[
                            { label: 'instrument', value: judgePrompt.instrument },
                            { label: 'version', value: judgePrompt.version },
                            { label: 'promptHash', value: judgePrompt.promptHash },
                            { label: 'source', value: judgePrompt.source },
                            { label: 'license', value: judgePrompt.license },
                            { label: 'paperDoi', value: judgePrompt.paperDoi },
                            { label: 'rubric', value: judgePrompt.rubricDimensions.join(', ') },
                        ]}
                    />
                </Card>

                <Card className="gap-3 p-4">
                    <h3 className="text-sm font-semibold">Sensor thresholds</h3>
                    <FieldList rows={Object.entries(sensorThresholds).map(([label, value]) => ({ label, value: String(value) }))} />
                </Card>

                <Card className="gap-3 p-4">
                    <h3 className="text-sm font-semibold">Safety criteria</h3>
                    {safetyCriteria.length === 0 ? (
                        <p className="text-muted-foreground text-xs">No safety criteria are enforced for this tenant.</p>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {safetyCriteria.map((criterion) => (
                                <li key={criterion.key} className="flex flex-wrap items-center gap-2">
                                    <Badge variant={criterion.enabled ? 'default' : 'outline'}>{criterion.enabled ? 'enforced' : 'off'}</Badge>
                                    <span className="text-sm">{criterion.label}</span>
                                    {criterion.detail ? <span className="text-muted-foreground font-mono text-xs">{criterion.detail}</span> : null}
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
            </div>
        </section>
    );
}

/**
 * Instructions tab — the effective agentic instruction set for the WORKING
 * TENANT, read from a (global)-tier screen.
 *
 * This is a documented instance of the "global-admin-only screen, per-tenant
 * data" sub-pattern: `/ai-services` lives in the `(global)` route
 * group, but this one tab reads tenant-scoped data, so it needs a working
 * tenant. The gate is applied at TAB level rather than via the screen-level
 * `WorkingTenantGate` — that component owns the page `<h1>`, and reusing it
 * inside a tab panel would put a second `h1` on the page (rule 11 §6). The
 * copy and behavior are otherwise identical to the shared gate: an elevated
 * session without a working tenant sees the empty state and fires no request.
 */
export function InstructionsPanel() {
    const session = useSession();
    const tenantId = session.data?.effectiveTenantId ?? undefined;
    // Elevated sessions must pick a tenant; tenant admins are pinned server-side.
    const gated = Boolean(session.data?.effectiveIsElevated) && !tenantId;
    const instructionsQuery = useAgenticInstructions({ tenantId }, Boolean(session.data) && !gated);

    if (!session.data) return <InstructionsSkeleton />;

    if (gated) {
        return (
            <EmptyState
                icon={IconBuilding}
                title="Select a working tenant"
                description="The instruction set is resolved per tenant. Pick a working tenant from the switcher in the top bar to load it."
            />
        );
    }

    if (instructionsQuery.isPending) return <InstructionsSkeleton />;

    if (instructionsQuery.error || !instructionsQuery.data) {
        return (
            <ErrorState
                title="Couldn’t load the instruction set"
                error={instructionsQuery.error}
                onRetry={() => void instructionsQuery.refetch()}
            />
        );
    }

    return <InstructionsDocument instructions={instructionsQuery.data} />;
}
