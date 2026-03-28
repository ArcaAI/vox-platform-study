import type { Meta, StoryObj } from '@storybook/react-vite';

import { ShineBorder } from '../../../registries/magicui/shine-border';

const meta = {
  title: 'Registries/MagicUI/ShineBorder',
  component: ShineBorder,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ShineBorder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="relative flex h-32 w-64 items-center justify-center rounded-xl border">
      <ShineBorder className="flex items-center justify-center">Shine Border</ShineBorder>
    </div>
  ),
};
