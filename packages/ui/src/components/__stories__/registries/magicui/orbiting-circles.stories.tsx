import type { Meta, StoryObj } from '@storybook/react-vite';

import { OrbitingCircles } from '../../../registries/magicui/orbiting-circles';

const meta = {
  title: 'Registries/MagicUI/OrbitingCircles',
  component: OrbitingCircles,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof OrbitingCircles>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="relative h-96 w-96">
      <OrbitingCircles>
        <div className="h-8 w-8 rounded-full bg-primary" />
        <div className="h-6 w-6 rounded-full bg-secondary" />
        <div className="h-4 w-4 rounded-full bg-muted" />
      </OrbitingCircles>
    </div>
  ),
};
