import type { Meta, StoryObj } from '@storybook/react-vite'

import { Slider } from '../../shadcn/slider'

const meta = {
  title: 'Components/Slider',
  component: Slider,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    defaultValue: {
      control: false,
    },
  },
} satisfies Meta<typeof Slider>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    defaultValue: [50],
    max: 100,
    step: 1,
    className: 'w-60',
  },
}

export const Range: Story = {
  render: () => (
    <div className="w-60">
      <Slider defaultValue={[25, 75]} max={100} step={1} />
    </div>
  ),
}

export const Steps: Story = {
  render: () => (
    <div className="flex w-60 flex-col gap-6">
      <div className="space-y-1">
        <span className="text-muted-foreground text-sm">Step: 10</span>
        <Slider defaultValue={[50]} max={100} step={10} />
      </div>
      <div className="space-y-1">
        <span className="text-muted-foreground text-sm">Step: 25</span>
        <Slider defaultValue={[50]} max={100} step={25} />
      </div>
    </div>
  ),
}

export const Disabled: Story = {
  args: {
    defaultValue: [50],
    max: 100,
    step: 1,
    disabled: true,
    className: 'w-60',
  },
}
