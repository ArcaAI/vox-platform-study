import type { Meta, StoryObj } from '@storybook/react-vite';

import { ThemeToggle } from '../../custom/theme-toggle';

const meta = {
  title: 'Custom/ThemeToggle',
  component: ThemeToggle,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ThemeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithCustomClass: Story = {
  args: {
    className: 'border rounded-full',
  },
};

export const InToolbar: Story = {
  render: () => (
    <div className="flex items-center gap-4 rounded-lg border px-4 py-2">
      <span className="text-sm font-medium">Settings</span>
      <div className="flex-1" />
      <ThemeToggle />
    </div>
  ),
};
