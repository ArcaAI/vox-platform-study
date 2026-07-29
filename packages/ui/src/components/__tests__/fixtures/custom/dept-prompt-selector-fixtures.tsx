import { useState } from 'react';
import { DeptPromptSelector, type DepartmentOption, type PromptOption } from '../../../custom/dept-prompt-selector';

const departments: DepartmentOption[] = [
  { id: 'cardiology', name: 'Cardiology' },
  { id: 'neurology', name: 'Neurology' },
];

const prompts: PromptOption[] = [
  { id: 'p1', name: 'Initial Consultation', category: 'General' },
  { id: 'p2', name: 'Follow-up Visit', category: 'General' },
];

export function DefaultSelector() {
  return <DeptPromptSelector departments={departments} prompts={prompts} onDepartmentChange={() => {}} onPromptChange={() => {}} />;
}

export function PreselectedSelector() {
  return (
    <DeptPromptSelector
      departments={departments}
      prompts={prompts}
      selectedDepartmentId="cardiology"
      selectedPromptId="p1"
      onDepartmentChange={() => {}}
      onPromptChange={() => {}}
    />
  );
}

export function LoadingSelector() {
  return <DeptPromptSelector departments={[]} prompts={[]} isLoading onDepartmentChange={() => {}} onPromptChange={() => {}} />;
}

export function InteractiveSelector({
  onDepartmentChange,
  onPromptChange,
}: {
  onDepartmentChange?: (id: string) => void;
  onPromptChange?: (id: string) => void;
}) {
  const [deptId, setDeptId] = useState<string | undefined>();
  const [promptId, setPromptId] = useState<string | undefined>();

  return (
    <div>
      <DeptPromptSelector
        departments={departments}
        prompts={deptId ? prompts : []}
        selectedDepartmentId={deptId}
        selectedPromptId={promptId}
        onDepartmentChange={(id) => {
          setDeptId(id);
          setPromptId(undefined);
          onDepartmentChange?.(id);
        }}
        onPromptChange={(id) => {
          setPromptId(id);
          onPromptChange?.(id);
        }}
      />
      <span data-testid="dept-value">{deptId ?? ''}</span>
      <span data-testid="prompt-value">{promptId ?? ''}</span>
    </div>
  );
}
