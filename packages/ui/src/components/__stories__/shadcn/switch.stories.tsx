import type { Meta, StoryObj } from '@storybook/react-vite';

import { Switch } from '../../shadcn/switch';
import { Label } from '../../shadcn/label';

const meta = {
  title: 'Components/Switch',
  component: Switch,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center space-x-2">
      <Switch id="airplane-mode" />
      <Label htmlFor="airplane-mode">Airplane Mode</Label>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center space-x-2">
        <Switch id="sm" size="sm" />
        <Label htmlFor="sm">Small</Label>
      </div>
      <div className="flex items-center space-x-2">
        <Switch id="default" />
        <Label htmlFor="default">Default</Label>
      </div>
    </div>
  ),
};

export const Checked: Story = {
  args: {
    defaultChecked: true,
  },
};

export const Disabled: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center space-x-2">
        <Switch id="disabled-off" disabled />
        <Label htmlFor="disabled-off">Disabled (off)</Label>
      </div>
      <div className="flex items-center space-x-2">
        <Switch id="disabled-on" disabled defaultChecked />
        <Label htmlFor="disabled-on">Disabled (on)</Label>
      </div>
    </div>
  ),
};

export const FormExample: Story = {
  render: () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="space-y-0.5">
          <Label>Marketing emails</Label>
          <p className="text-muted-foreground text-sm">Receive emails about new products and features.</p>
        </div>
        <Switch />
      </div>
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="space-y-0.5">
          <Label>Security emails</Label>
          <p className="text-muted-foreground text-sm">Receive emails about your account security.</p>
        </div>
        <Switch defaultChecked />
      </div>
    </div>
  ),
};
