import type { Meta, StoryObj } from '@storybook/react-vite';

import { Switch } from '../../../registries/basecn/switch';
import { Label } from '../../../registries/basecn/label';

const meta = {
  title: 'Registries/Basecn/Switch',
  component: Switch,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <div className="flex items-center gap-2">
      <Switch id="airplane" />
      <Label htmlFor="airplane">Airplane Mode</Label>
    </div>
  ),
};

export const Disabled: Story = {
  args: {} as any,
  render: () => (
    <div className="flex items-center gap-2">
      <Switch id="disabled" disabled />
      <Label htmlFor="disabled">Disabled</Label>
    </div>
  ),
};
