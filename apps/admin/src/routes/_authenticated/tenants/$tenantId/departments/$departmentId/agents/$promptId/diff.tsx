import { Button } from '@arcaai/ui/button';
import { Spinner } from '@arcaai/ui/spinner';
import { usePrompts, type PromptVersionDiff } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { InstructionWorkspaceShell } from '@/features/agents/instruction-workspace';
import { useInstructionWorkspace } from '@/features/agents/instruction-workspace-context';
import { useDepartmentScope } from '@/features/agents/use-department-scope';
import { reduceOccConflict } from '@/features/common/occ';
import { VersionDiff } from '@/features/agents/version-diff';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/departments/$departmentId/agents/$promptId/diff')({
  component: VersionDiffPage,
});

function VersionDiffPage() {
  const { tenantId, departmentId, promptId } = Route.useParams();
  const { prompt, versions, reload } = useInstructionWorkspace();
  const { canManage } = useDepartmentScope();
  const { compareVersionsDetailed, activateVersion } = usePrompts();

  const [base, setBase] = useState(0);
  const [compare, setCompare] = useState(0);
  const [diff, setDiff] = useState<PromptVersionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<Error | null>(null);
  const [activatingVersion, setActivatingVersion] = useState<number | null>(null);

  // Default selection: compare the latest version against the active one (frame 32).
  useEffect(() => {
    if (versions.length === 0) return;
    const nums = versions.map((v) => v.versionNumber).sort((a, b) => b - a);
    const latest = nums[0];
    const active = prompt.currentVersionNumber;
    setBase((b) => (b > 0 ? b : active !== latest ? active : (nums[1] ?? latest)));
    setCompare((c) => (c > 0 ? c : latest));
  }, [versions, prompt.currentVersionNumber]);

  const loadDiff = useCallback(() => {
    if (base <= 0 || compare <= 0 || base === compare) {
      setDiff(null);
      return;
    }
    setDiffLoading(true);
    setDiffError(null);
    compareVersionsDetailed(promptId, base, compare)
      .then(setDiff)
      .catch((e) => setDiffError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => setDiffLoading(false));
  }, [promptId, base, compare, compareVersionsDetailed]);

  useEffect(() => {
    loadDiff();
  }, [loadDiff]);

  const activate = async (versionNumber: number) => {
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

  const current = prompt.currentVersionNumber;
  const busy = activatingVersion != null;

  return (
    <InstructionWorkspaceShell
      prompt={prompt}
      tenantId={tenantId}
      departmentId={departmentId}
      promptId={promptId}
      active="diff"
      actions={
        canManage ? (
          <>
            <Button variant="outline" disabled={busy || base <= 0 || base === current} onClick={() => activate(base)}>
              {activatingVersion === base ? <Spinner className="size-4" /> : <RotateCcw className="size-4" />}
              Roll back to v{base || '—'}
            </Button>
            <Button disabled={busy || compare <= 0 || compare === current} onClick={() => activate(compare)}>
              {activatingVersion === compare ? <Spinner className="size-4" /> : null}
              Activate v{compare || '—'}
            </Button>
          </>
        ) : null
      }
    >
      <VersionDiff
        versions={versions}
        base={base}
        compare={compare}
        onBaseChange={setBase}
        onCompareChange={setCompare}
        diff={diff}
        isLoading={diffLoading}
        error={diffError}
        onRetry={loadDiff}
      />
    </InstructionWorkspaceShell>
  );
}
