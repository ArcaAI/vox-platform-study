import { Button } from '@arcaai/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Skeleton } from '@arcaai/ui/skeleton';
import { usePrompts, type PromptTemplate, type PromptVersion } from '@arcaai/vox';
import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { InstructionWorkspaceProvider } from '@/features/agents/instruction-workspace-context';

/**
 * Instruction-workspace layout (TASK-382 §2.1, frames 31–33). Fetches the prompt +
 * its version history once and shares them with the Editor / Diff / Playground leaves
 * via context, gating on load so consumers always read a non-null prompt. Appends a
 * single `Agent instructions` crumb (the active mode is shown by the workspace tabs).
 */
export const Route = createFileRoute('/_authenticated/tenants/$tenantId/departments/$departmentId/agents/$promptId')({
    staticData: { crumb: [{ label: 'Agent instructions', to: '/tenants/$tenantId/departments/$departmentId/agents' }] },
    component: InstructionWorkspaceLayout,
});

function InstructionWorkspaceLayout() {
    const { tenantId, departmentId, promptId } = Route.useParams();
    const { get, getVersions } = usePrompts();

    const [prompt, setPrompt] = useState<PromptTemplate | null>(null);
    const [versions, setVersions] = useState<PromptVersion[]>([]);
    const [versionsLoading, setVersionsLoading] = useState(true);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const loadPrompt = useCallback(() => {
        setLoading(true);
        setError(null);
        get(promptId)
            .then(setPrompt)
            .catch((e) => setError(e instanceof Error ? e : new Error(String(e))))
            .finally(() => setLoading(false));
    }, [promptId, get]);

    const loadVersions = useCallback(() => {
        setVersionsLoading(true);
        getVersions(promptId)
            .then(setVersions)
            .catch(() => setVersions([]))
            .finally(() => setVersionsLoading(false));
    }, [promptId, getVersions]);

    const reload = useCallback(() => {
        loadPrompt();
        loadVersions();
    }, [loadPrompt, loadVersions]);

    useEffect(() => {
        reload();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [promptId]);

    if (loading && !prompt) {
        return (
            <div className="space-y-5">
                <Skeleton className="h-4 w-32" />
                <div className="flex items-center gap-3">
                    <Skeleton className="size-12 rounded-lg" />
                    <div className="space-y-2">
                        <Skeleton className="h-6 w-56" />
                        <Skeleton className="h-4 w-72" />
                    </div>
                </div>
                <Skeleton className="h-9 w-72" />
                <Skeleton className="h-80 w-full" />
            </div>
        );
    }

    if (error || !prompt) {
        return (
            <Empty>
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Sparkles />
                    </EmptyMedia>
                    <EmptyTitle>Instruction not found</EmptyTitle>
                    <EmptyDescription>This agent instruction doesn’t exist or you don’t have access to it.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                    <Button asChild variant="outline">
                        <Link to="/tenants/$tenantId/departments/$departmentId/agents" params={{ tenantId, departmentId }}>
                            Back to agent instructions
                        </Link>
                    </Button>
                </EmptyContent>
            </Empty>
        );
    }

    return (
        <InstructionWorkspaceProvider value={{ prompt, versions, versionsLoading, reload }}>
            <Outlet />
        </InstructionWorkspaceProvider>
    );
}
