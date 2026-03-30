import type { Meta, StoryObj } from '@storybook/react-vite';

import { Ripple } from '../../../registries/magicui/ripple';

const meta = {
  title: 'Registries/MagicUI/Ripple',
  component: Ripple,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof Ripple>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="relative flex h-screen w-full items-center justify-center">
      <Ripple />
    </div>
  ),
};
