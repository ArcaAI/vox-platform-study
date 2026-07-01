import { Button } from '@arcaai/ui/button';
import { useDepartments, usePrompts, type PromptTemplate } from '@arcaai/vox';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AssignSlotDialog } from '@/features/agents/assign-slot-dialog';
import { DefaultAgentSlots } from '@/features/agents/default-agent-slots';
import { DepartmentDetailShell } from '@/features/agents/department-shell';
import { InstructionLibrary } from '@/features/agents/instruction-library';
import { resolveSlotAssignments, slotAssignInput, type AgentSlot } from '@/features/agents/slot-config';
import { useDepartmentScope } from '@/features/agents/use-department-scope';
import { reduceOccConflict } from '@/features/common/occ';
import { AgentInstructionDialog } from '@/features/tenants/agent-instruction-dialog';
import { toCreatePromptInput, type AgentInstructionDraft } from '@/features/tenants/agent-instruction-draft';
import { ActingOnBanner } from '@/features/tenants/tenant-context';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/departments/$departmentId/agents/')({
    component: AgentManagementPage,
});

function AgentManagementPage() {
    const { tenantId, departmentId } = Route.useParams();
    const navigate = useNavigate();
    const { department, tenant, superAdmin, canManage } = useDepartmentScope();

    const { list: listPrompts, create: createPrompt, assignToDepartment } = usePrompts();
    const { get: getDepartment, updatePromptConfig } = useDepartments();
    const setDepartment = useTenantDetailStore((s) => s.setDepartment);

    const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
    const [promptsLoading, setPromptsLoading] = useState(true);
    const [promptsError, setPromptsError] = useState<Error | null>(null);

    const [assignSlot, setAssignSlot] = useState<AgentSlot | null>(null);
    const [isAssigning, setIsAssigning] = useState(false);
    const [instrOpen, setInstrOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const loadPrompts = () => {
        setPromptsLoading(true);
        setPromptsError(null);
        listPrompts({ departmentId })
            .then((items) => setPrompts(items))
            .catch((e) => setPromptsError(e instanceof Error ? e : new Error(String(e))))
            .finally(() => setPromptsLoading(false));
    };

    useEffect(() => {
        loadPrompts();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [departmentId]);

    const sortedPrompts = useMemo(
        () => [...prompts].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
        [prompts],
    );
    const assignments = useMemo(() => (department ? resolveSlotAssignments(department, prompts) : []), [department, prompts]);
    const currentAssignId = useMemo(
        () => (assignSlot ? (assignments.find((a) => a.slot.key === assignSlot.key)?.promptId ?? null) : null),
        [assignSlot, assignments],
    );

    const goEditor = (prompt: PromptTemplate) => navigate({ to: '/tenants/$tenantId/departments/$departmentId/agents/$promptId', params: { tenantId, departmentId, promptId: prompt.id } });
    const goDiff = (prompt: PromptTemplate) => navigate({ to: '/tenants/$tenantId/departments/$departmentId/agents/$promptId/diff', params: { tenantId, departmentId, promptId: prompt.id } });
    const goPlayground = (prompt: PromptTemplate) =>
        navigate({ to: '/tenants/$tenantId/departments/$departmentId/agents/$promptId/playground', params: { tenantId, departmentId, promptId: prompt.id } });

    const handleAssign = async (promptId: string) => {
        if (!assignSlot || !department) return;
        // OCC: echo the department's read version; both write paths CAS-check it
        // (412 on drift, surfaced via reduceOccConflict below).
        const expectedVersion = typeof department.version === 'number' ? department.version : 0;
        setIsAssigning(true);
        try {
            if (assignSlot.promptConfigField) {
                // DNA writing-style lives on Department.dnaWritingStylePromptId, which the
                // assign-department POST doesn't whitelist — write it through the
                // prompt-config PATCH (TASK-387 #7), carrying the OCC token in the body.
                await updatePromptConfig(departmentId, { [assignSlot.promptConfigField]: promptId, expectedVersion });
            } else {
                const input = slotAssignInput(assignSlot, departmentId, promptId, expectedVersion);
                if (!input) return;
                await assignToDepartment(input);
            }
            const fresh = await getDepartment(departmentId);
            setDepartment(fresh);
            toast.success(`${assignSlot.label} updated`);
            setAssignSlot(null);
        } catch (err) {
            const occ = reduceOccConflict(err);
            if (occ.conflict) {
                const fresh = await getDepartment(departmentId).catch(() => null);
                if (fresh) setDepartment(fresh);
                toast.error(occ.message!);
            } else {
                toast.error(err instanceof Error ? err.message : 'Failed to assign instruction');
            }
        } finally {
            setIsAssigning(false);
        }
    };

    const handleCreateInstruction = async (draft: AgentInstructionDraft) => {
        setIsSaving(true);
        try {
            await createPrompt(toCreatePromptInput(draft, departmentId));
            toast.success('Agent instruction created');
            setInstrOpen(false);
            loadPrompts();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to create instruction');
        } finally {
            setIsSaving(false);
        }
    };

    if (!department) return null;

    return (
        <DepartmentDetailShell
            department={department}
            tenant={tenant}
            tenantId={tenantId}
            departmentId={departmentId}
            active="agents"
            actions={
                canManage ? (
                    <Button onClick={() => setInstrOpen(true)}>
                        <Plus className="size-4" />
                        New instruction
                    </Button>
                ) : null
            }
        >
            <section className="space-y-3">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <h2 className="text-sm font-semibold">Default agents</h2>
                    <p className="text-xs text-muted-foreground">Wired to {department.name}’s consultation pipeline</p>
                </div>
                <DefaultAgentSlots
                    assignments={assignments}
                    isLoading={promptsLoading && prompts.length === 0}
                    canManage={canManage}
                    onChange={setAssignSlot}
                    onEdit={goEditor}
                    onHistory={goDiff}
                    onTest={goPlayground}
                />
            </section>

            <section className="space-y-3">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <h2 className="text-sm font-semibold">Instruction library</h2>
                    <p className="text-xs text-muted-foreground">
                        <span className="tabular-nums">{prompts.length}</span> template{prompts.length === 1 ? '' : 's'} · sorted by last updated
                    </p>
                </div>
                <InstructionLibrary
                    prompts={sortedPrompts}
                    isLoading={promptsLoading}
                    error={promptsError}
                    onRetry={loadPrompts}
                    onOpen={goEditor}
                    emptyLabel="No agent instructions yet"
                />
            </section>

            {superAdmin && tenant ? (
                <ActingOnBanner
                    tenantName={`${department.name} · ${tenant.name}`}
                    description="Agent instructions are PromptTemplate rows scoped DEPARTMENT_DEFAULT. The summary slots wire via Department.preSummaryPromptId / newPatientPromptId / revisitPromptId; the DNA writing-style default wires Department.dnaWritingStylePromptId via the prompt-config PATCH."
                />
            ) : null}

            <AssignSlotDialog
                open={assignSlot != null}
                onOpenChange={(open) => !open && setAssignSlot(null)}
                slotLabel={assignSlot?.label ?? ''}
                options={prompts}
                currentId={currentAssignId}
                isSaving={isAssigning}
                onConfirm={handleAssign}
            />

            <AgentInstructionDialog open={instrOpen} onOpenChange={setInstrOpen} departmentName={department.name} isSaving={isSaving} onSave={handleCreateInstruction} />
        </DepartmentDetailShell>
    );
}
