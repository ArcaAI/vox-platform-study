import { Button } from '@arcaai/ui/button';
import { Spinner } from '@arcaai/ui/spinner';
import { usePrompts } from '@arcaai/vox';
import type { PromptTestResult } from '@/features/agents/sdk-types';
import { createFileRoute } from '@tanstack/react-router';
import { Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { parseVariableNames } from '@/features/agents/instruction-draft';
import { resolveTestVariables } from '@/features/agents/playground-format';
import { InstructionWorkspaceShell } from '@/features/agents/instruction-workspace';
import { useInstructionWorkspace } from '@/features/agents/instruction-workspace-context';
import { TestPlayground } from '@/features/agents/test-playground';
import { useDepartmentScope } from '@/features/agents/use-department-scope';
import { reduceOccConflict } from '@/features/common/occ';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/departments/$departmentId/agents/$promptId/playground')({
  component: TestPlaygroundPage,
});

const EXAMPLE_INPUT = `[00:12] Dr. Lee: What brings you in today?
[00:15] Patient: I've had chest tightness when I walk up stairs — started about 3 days ago.
[00:24] Dr. Lee: Does it ease up when you rest?
[00:27] Patient: Yeah, after a few minutes.
[00:33] Dr. Lee: Any high blood pressure or smoking history?
[00:38] Patient: High BP, and I used to smoke.`;

function TestPlaygroundPage() {
  const { tenantId, departmentId, promptId } = Route.useParams();
  const { prompt } = useInstructionWorkspace();
  const { canManage } = useDepartmentScope();
  const { test } = usePrompts();

  const variableNames = useMemo(() => parseVariableNames(prompt.content), [prompt.content]);

  const [values, setValues] = useState<Record<string, string>>({});
  const [sampleInput, setSampleInput] = useState('');
  const [result, setResult] = useState<PromptTestResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [testError, setTestError] = useState<Error | null>(null);

  // Fresh sandbox per instruction.
  useEffect(() => {
    setValues({});
    setSampleInput('');
    setResult(null);
    setTestError(null);
  }, [prompt.id]);

  const runTest = async () => {
    setIsRunning(true);
    setTestError(null);
    try {
      const data = await test(promptId, {
        variables: resolveTestVariables(variableNames, values),
        sampleInput: sampleInput.trim() || undefined,
        expectedVersion: prompt.version,
      });
      setResult(data);
    } catch (err) {
      const occ = reduceOccConflict(err);
      const message = occ.conflict ? occ.message! : err instanceof Error ? err.message : 'Test run failed';
      setTestError(new Error(message));
      toast.error(message);
    } finally {
      setIsRunning(false);
    }
  };

  const reset = () => {
    setValues({});
    setSampleInput('');
    setResult(null);
    setTestError(null);
  };

  return (
    <InstructionWorkspaceShell
      prompt={prompt}
      tenantId={tenantId}
      departmentId={departmentId}
      promptId={promptId}
      active="playground"
      actions={
        canManage ? (
          <>
            <Button variant="outline" disabled={isRunning} onClick={reset}>
              Reset
            </Button>
            <Button disabled={isRunning} onClick={runTest}>
              {isRunning ? <Spinner className="size-4" /> : <Play className="size-4" />}
              Run test
            </Button>
          </>
        ) : null
      }
    >
      <TestPlayground
        prompt={prompt}
        variableNames={variableNames}
        values={values}
        onValueChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
        sampleInput={sampleInput}
        onSampleInputChange={setSampleInput}
        onLoadExample={() => setSampleInput(EXAMPLE_INPUT)}
        result={result}
        isRunning={isRunning}
        error={testError}
        canManage={canManage}
      />
    </InstructionWorkspaceShell>
  );
}
