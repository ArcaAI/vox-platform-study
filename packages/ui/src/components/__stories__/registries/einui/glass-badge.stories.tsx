import type { Meta, StoryObj } from '@storybook/react-vite';
import { GlassBadge } from '@/components/registries/einui/glass-badge';

const meta = {
  title: 'Registries/EinUI/GlassBadge',
  component: GlassBadge,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof GlassBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Badge',
  },
};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <GlassBadge variant="primary">Primary</GlassBadge>
      <GlassBadge variant="success">Success</GlassBadge>
      <GlassBadge variant="warning">Warning</GlassBadge>
      <GlassBadge variant="destructive">Destructive</GlassBadge>
      <GlassBadge variant="outline">Outline</GlassBadge>
    </div>
  ),
};
