import type { Meta, StoryObj } from '@storybook/react-vite';

import { Badge } from '../../shadcn/badge';

const meta = {
  title: 'Components/Badge',
  component: Badge,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'secondary', 'destructive', 'outline'],
      description: 'The visual style of the badge',
    },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default badge
export const Default: Story = {
  args: {
    children: 'Badge',
  },
};

// All variants
export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="destructive">Destructive</Badge>
      <Badge variant="outline">Outline</Badge>
    </div>
  ),
};

// Usage examples
export const Examples: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span>Status:</span>
        <Badge variant="default">Active</Badge>
      </div>
      <div className="flex items-center gap-2">
        <span>Priority:</span>
        <Badge variant="destructive">High</Badge>
      </div>
      <div className="flex items-center gap-2">
        <span>Type:</span>
        <Badge variant="secondary">Feature</Badge>
      </div>
      <div className="flex items-center gap-2">
        <span>Version:</span>
        <Badge variant="outline">v1.0.0</Badge>
      </div>
    </div>
  ),
};
