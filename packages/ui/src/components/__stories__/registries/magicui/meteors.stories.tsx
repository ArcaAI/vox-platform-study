import type { Meta, StoryObj } from '@storybook/react-vite';

import { Meteors } from '../../../registries/magicui/meteors';

const meta = {
  title: 'Registries/MagicUI/Meteors',
  component: Meteors,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Meteors>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="relative h-48 w-96 rounded-xl border bg-background overflow-hidden">
      <Meteors />
    </div>
  ),
};
