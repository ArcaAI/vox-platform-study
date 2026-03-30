import type { Meta, StoryObj } from '@storybook/react-vite';

import { Progress, ProgressTrack, ProgressIndicator } from '../../../registries/basecn/progress';

const meta = {
  title: 'Registries/Basecn/Progress',
  component: Progress,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Progress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <Progress value={60} className="w-[300px]">
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </Progress>
  ),
};

export const Half: Story = {
  args: {} as any,
  render: () => (
    <Progress value={50} className="w-[300px]">
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </Progress>
  ),
};
