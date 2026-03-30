import type { Meta, StoryObj } from '@storybook/react-vite';

import { NeonGradientCard } from '../../../registries/magicui/neon-gradient-card';

const meta = {
  title: 'Registries/MagicUI/NeonGradientCard',
  component: NeonGradientCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof NeonGradientCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Neon gradient card content',
  },
  render: (args) => (
    <div className="h-48 w-80">
      <NeonGradientCard {...args} />
    </div>
  ),
};
