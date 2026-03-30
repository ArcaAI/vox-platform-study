import type { Meta, StoryObj } from '@storybook/react-vite';
import { GlassProgress } from '@/components/registries/einui/glass-progress';

const meta = {
  title: 'Registries/EinUI/GlassProgress',
  component: GlassProgress,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof GlassProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    value: 60,
  },
};

export const Empty: Story = {
  args: {
    value: 0,
  },
};

export const Full: Story = {
  args: {
    value: 100,
  },
};
