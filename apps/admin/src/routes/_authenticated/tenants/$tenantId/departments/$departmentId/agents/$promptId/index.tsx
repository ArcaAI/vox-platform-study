import { Button } from '@arcaai/ui/button';
import { Spinner } from '@arcaai/ui/spinner';
import { usePrompts } from '@arcaai/vox';
import type { PromptTemplateStatus } from '@/features/agents/sdk-types';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { InstructionEditor } from '@/features/agents/instruction-editor';
import { toUpdatePromptInput } from '@/features/agents/instruction-draft';
import { InstructionWorkspaceShell } from '@/features/agents/instruction-workspace';
import { useInstructionWorkspace } from '@/features/agents/instruction-workspace-context';
import { useDepartmentScope } from '@/features/agents/use-department-scope';
import { reduceOccConflict } from '@/features/common/occ';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/departments/$departmentId/agents/$promptId/')({
  component: InstructionEditorPage,
});

function InstructionEditorPage() {
  const { tenantId, departmentId, promptId } = Route.useParams();
  const { prompt, versions, versionsLoading, reload } = useInstructionWorkspace();
  const { canManage } = useDepartmentScope();
  const { update, activateVersion } = usePrompts();

  const [content, setContent] = useState(prompt.content);
  const [changeReason, setChangeReason] = useState('');
  const [savingStatus, setSavingStatus] = useState<PromptTemplateStatus | null>(null);
  const [activatingVersion, setActivatingVersion] = useState<number | null>(null);

  // Resync the editor when the underlying row changes (after save / activate / nav).
  useEffect(() => {
    setContent(prompt.content);
    setChangeReason('');
  }, [prompt.id, prompt.updatedAt, prompt.content]);

  const canSave = canManage && content.trim().length > 0 && changeReason.trim().length > 0 && savingStatus == null;

  const save = async (status: PromptTemplateStatus) => {
    setSavingStatus(status);
    try {
      await update(promptId, toUpdatePromptInput({ content, status, changeReason }, prompt.version));
      toast.success(status === 'PUBLISHED' ? 'Published new version' : 'Draft saved');
      reload();
    } catch (err) {
      const occ = reduceOccConflict(err);
      if (occ.conflict) {
        toast.error(occ.message!);
        reload();
      } else {
        toast.error(err instanceof Error ? err.message : 'Failed to save instruction');
      }
    } finally {
      setSavingStatus(null);
    }
  };

  const handleActivate = async (versionNumber: number) => {
    setActivatingVersion(versionNumber);
    try {
      await activateVersion(promptId, versionNumber);
      toast.success(`Activated v${versionNumber}`);
      reload();
    } catch (err) {
      const occ = reduceOccConflict(err);
      if (occ.conflict) {
        toast.error(occ.message!);
        reload();
      } else {
        toast.error(err instanceof Error ? err.message : 'Failed to activate version');
      }
    } finally {
      setActivatingVersion(null);
    }
  };

  return (
    <InstructionWorkspaceShell
      prompt={prompt}
      tenantId={tenantId}
      departmentId={departmentId}
      promptId={promptId}
      active="editor"
      actions={
        canManage ? (
          <>
            <Button variant="outline" disabled={!canSave} onClick={() => save('DRAFT')}>
              {savingStatus === 'DRAFT' ? <Spinner className="size-4" /> : 'Save draft'}
            </Button>
            <Button disabled={!canSave} onClick={() => save('PUBLISHED')}>
              {savingStatus === 'PUBLISHED' ? <Spinner className="size-4" /> : 'Publish version'}
            </Button>
          </>
        ) : null
      }
    >
      <InstructionEditor
        prompt={prompt}
        versions={versions}
        versionsLoading={versionsLoading}
        content={content}
        onContentChange={setContent}
        changeReason={changeReason}
        onChangeReasonChange={setChangeReason}
        canManage={canManage}
        onActivate={handleActivate}
        activatingVersion={activatingVersion}
      />
    </InstructionWorkspaceShell>
  );
}
