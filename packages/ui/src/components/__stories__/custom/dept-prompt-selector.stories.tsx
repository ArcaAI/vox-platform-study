import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { DeptPromptSelector, type DepartmentOption, type PromptOption } from '../../custom/dept-prompt-selector';

const departments: DepartmentOption[] = [
  { id: 'cardiology', name: 'Cardiology' },
  { id: 'neurology', name: 'Neurology' },
  { id: 'oncology', name: 'Oncology' },
  { id: 'radiology', name: 'Radiology' },
];

const prompts: PromptOption[] = [
  { id: 'p1', name: 'Initial Consultation', category: 'General' },
  { id: 'p2', name: 'Follow-up Visit', category: 'General' },
  { id: 'p3', name: 'Diagnostic Summary', category: 'Reports' },
  { id: 'p4', name: 'Treatment Plan', category: 'Clinical' },
];

const meta = {
  title: 'Custom/DeptPromptSelector',
  component: DeptPromptSelector,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    isLoading: {
      control: 'boolean',
      description: 'Whether the selector is in a loading state',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DeptPromptSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    departments,
    prompts,
    onDepartmentChange: (id) => console.log('Department:', id),
    onPromptChange: (id) => console.log('Prompt:', id),
  },
};

export const WithDepartmentSelected: Story = {
  args: {
    departments,
    prompts,
    selectedDepartmentId: 'cardiology',
    onDepartmentChange: (id) => console.log('Department:', id),
    onPromptChange: (id) => console.log('Prompt:', id),
  },
};

export const FullySelected: Story = {
  args: {
    departments,
    prompts,
    selectedDepartmentId: 'neurology',
    selectedPromptId: 'p3',
    onDepartmentChange: (id) => console.log('Department:', id),
    onPromptChange: (id) => console.log('Prompt:', id),
  },
};

export const Loading: Story = {
  args: {
    departments: [],
    prompts: [],
    isLoading: true,
    onDepartmentChange: () => {},
    onPromptChange: () => {},
  },
};

export const EmptyDepartments: Story = {
  args: {
    departments: [],
    prompts: [],
    onDepartmentChange: () => {},
    onPromptChange: () => {},
  },
};

function InteractiveDemo() {
  const [deptId, setDeptId] = useState<string | undefined>();
  const [promptId, setPromptId] = useState<string | undefined>();

  return (
    <div className="space-y-4">
      <DeptPromptSelector
        departments={departments}
        prompts={deptId ? prompts : []}
        selectedDepartmentId={deptId}
        selectedPromptId={promptId}
        onDepartmentChange={(id) => {
          setDeptId(id);
          setPromptId(undefined);
        }}
        onPromptChange={setPromptId}
      />
      <p className="text-xs text-muted-foreground">
        Selected: {deptId ?? '—'} / {promptId ?? '—'}
      </p>
    </div>
  );
}

export const Interactive: Story = {
  args: {} as any,
  render: () => <InteractiveDemo />,
};
