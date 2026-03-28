import type { Meta, StoryObj } from '@storybook/react-vite';

import { Comparison, ComparisonItem, ComparisonHandle } from '../../../registries/kibo-ui/comparison';

const meta = {
  title: 'Registries/KiboUI/Comparison',
  component: Comparison,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Comparison>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Comparison className="h-64 w-96 rounded-lg border">
      <ComparisonItem position="left">
        <div className="flex h-full w-full items-center justify-center bg-blue-100 text-blue-800">Before</div>
      </ComparisonItem>
      <ComparisonItem position="right">
        <div className="flex h-full w-full items-center justify-center bg-green-100 text-green-800">After</div>
      </ComparisonItem>
      <ComparisonHandle />
    </Comparison>
  ),
};
