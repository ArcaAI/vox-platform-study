import type { Meta, StoryObj } from '@storybook/react-vite';

import { QuestionFlow } from '../../../registries/tool-ui/question-flow';

const meta = {
  title: 'Registries/ToolUI/QuestionFlow',
  component: QuestionFlow,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof QuestionFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <QuestionFlow
      id="1"
      step={1}
      title="What would you like to do?"
      options={[
        { id: 'opt1', label: 'Option A' },
        { id: 'opt2', label: 'Option B' },
        { id: 'opt3', label: 'Option C' },
      ]}
    />
  ),
};
