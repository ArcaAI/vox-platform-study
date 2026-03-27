import type { Meta, StoryObj } from '@storybook/react-vite';

import { RetroGrid } from '../../../registries/magicui/retro-grid';

const meta = {
  title: 'Registries/MagicUI/RetroGrid',
  component: RetroGrid,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof RetroGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="relative h-screen w-full">
      <RetroGrid />
    </div>
  ),
};
