import type { Meta, StoryObj } from '@storybook/react-vite';

import { Input } from '../../../registries/basecn/input';
import { Label } from '../../../registries/basecn/label';

const meta = {
  title: 'Registries/Basecn/Input',
  component: Input,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    placeholder: 'Enter text...',
    className: 'w-[300px]',
  },
};

export const WithLabel: Story = {
  args: {} as any,
  render: () => (
    <div className="grid w-[300px] gap-1.5">
      <Label htmlFor="email">Email</Label>
      <Input id="email" type="email" placeholder="you@example.com" />
    </div>
  ),
};

export const Disabled: Story = {
  args: {
    placeholder: 'Disabled',
    disabled: true,
    className: 'w-[300px]',
  },
};
