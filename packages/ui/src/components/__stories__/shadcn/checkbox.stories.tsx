import type { Meta, StoryObj } from '@storybook/react-vite'

import { Checkbox } from '../../shadcn/checkbox'
import { Label } from '../../shadcn/label'

const meta = {
  title: 'Components/Checkbox',
  component: Checkbox,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    disabled: {
      control: 'boolean',
      description: 'Whether the checkbox is disabled',
    },
    defaultChecked: {
      control: 'boolean',
      description: 'Whether the checkbox is checked by default',
    },
  },
} satisfies Meta<typeof Checkbox>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="terms" />
      <Label htmlFor="terms">Accept terms and conditions</Label>
    </div>
  ),
}

export const Disabled: Story = {
  args: {
    disabled: true,
  },
  render: (args) => (
    <div className="flex items-center gap-2">
      <Checkbox id="disabled" {...args} />
      <Label htmlFor="disabled" className="text-muted-foreground">
        Disabled checkbox
      </Label>
    </div>
  ),
}

export const CheckedByDefault: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="checked" defaultChecked />
      <Label htmlFor="checked">Checked by default</Label>
    </div>
  ),
}
