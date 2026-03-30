import type { Meta, StoryObj } from '@storybook/react-vite';
import { GlassSwitch } from '@/components/registries/einui/glass-switch';

const meta = {
  title: 'Registries/EinUI/GlassSwitch',
  component: GlassSwitch,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof GlassSwitch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = {
  args: {
    defaultChecked: true,
  },
};
