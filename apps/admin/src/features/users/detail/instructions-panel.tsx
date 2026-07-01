import { Button } from '@arcaai/ui/button';
import { Alert, AlertDescription } from '@arcaai/ui/alert';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { usePrompts, type PromptTemplate, type User } from '@arcaai/vox';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Info, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '@/lib/utils';

function promptStatusRole(status?: string) {
    return String(status ?? '').toUpperCase() === 'PUBLISHED' ? ('success' as const) : ('neutral' as const);
}

/**
 * 38u **Agent instructions** tab. REAL: the `PromptTemplate` rows for each
 * department the user is assigned to (`usePrompts.list({ departmentId })`). The
 * design's *per-user* personalization (a `USER_PERSONAL` / `ownerUserId` scope)
 * is a TARGET — `PromptTemplate` has no per-user scope — so we surface the
 * department defaults that apply to the user and flag the personalization gap.
 */
export function InstructionsPanel({
    user,
    departments,
    tenantId,
}: {
    user: User;
    departments: { id: string; name: string }[];
    tenantId: string;
}) {
    const { list } = usePrompts();
    const [byDept, setByDept] = useState<Record<string, PromptTemplate[]>>({});
    const [loading, setLoading] = useState(true);

    const assignedIds = useMemo(() => user.departmentIds ?? [], [user.departmentIds]);
    const nameById = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        Promise.allSettled(assignedIds.map((departmentId) => list({ departmentId }).then((items) => [departmentId, items] as const)))
            .then((results) => {
                if (cancelled) return;
                const next: Record<string, PromptTemplate[]> = {};
                for (const r of results) if (r.status === 'fulfilled') next[r.value[0]] = r.value[1];
                setByDept(next);
            })
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(assignedIds)]);

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-base font-semibold">Agent instructions</h2>
                    <p className="text-sm text-muted-foreground">Prompt instructions applied when this user works in each assigned department.</p>
                </div>
            </div>

            <Alert>
                <Info />
                <AlertDescription>
                    <span className="font-medium text-foreground">Target ·</span> instructions are scoped per department today; per-user personalization
                    (a personal prompt overriding the department default) ships later. Edit the department instruction from its workspace.
                </AlertDescription>
            </Alert>

            {loading ? (
                <div className="space-y-3">
                    <Skeleton className="h-28 w-full" />
                    <Skeleton className="h-28 w-full" />
                </div>
            ) : assignedIds.length === 0 ? (
                <Empty>
                    <EmptyHeader>
                        <EmptyMedia variant="icon">
                            <Sparkles />
                        </EmptyMedia>
                        <EmptyTitle>No assigned departments</EmptyTitle>
                        <EmptyDescription>Assign this user to a department to surface its agent instructions here.</EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : (
                assignedIds.map((deptId) => {
                    const prompts = byDept[deptId] ?? [];
                    const isPrimary = user.primaryDepartmentId === deptId;
                    return (
                        <Card key={deptId} className="p-5">
                            <div className="mb-3 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <h3 className="text-sm font-semibold">{nameById.get(deptId) ?? deptId}</h3>
                                    <StatusBadge label={isPrimary ? 'Primary' : 'Member'} colorRole={isPrimary ? 'info' : 'neutral'} />
                                </div>
                                <Button asChild variant="ghost" size="sm" className="h-7 text-primary">
                                    <Link to="/tenants/$tenantId/departments/$departmentId" params={{ tenantId, departmentId: deptId }}>
                                        Manage <ArrowRight className="size-3.5" />
                                    </Link>
                                </Button>
                            </div>
                            {prompts.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No agent instructions for this department yet.</p>
                            ) : (
                                <ul className="space-y-3">
                                    {prompts.map((p) => (
                                        <li key={p.id} className="rounded-md border bg-muted/20 p-3">
                                            <div className="mb-1 flex items-center justify-between gap-2">
                                                <span className="flex items-center gap-2 text-sm font-medium">
                                                    <Sparkles aria-hidden className="size-3.5 text-ai" />
                                                    {p.name}
                                                </span>
                                                <StatusBadge label={`v${p.currentVersionNumber} · ${(p.status ?? 'DRAFT').toLowerCase()}`} colorRole={promptStatusRole(p.status)} />
                                            </div>
                                            <p className="mb-2 text-xs text-muted-foreground">
                                                {p.category} · updated {formatDateTime(p.updatedAt)}
                                            </p>
                                            <p className="line-clamp-3 text-sm text-foreground/90">{p.content}</p>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Card>
                    );
                })
            )}
        </div>
    );
}
