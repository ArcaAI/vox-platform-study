import type { Meta, StoryObj } from '@storybook/react-vite'

import { Progress } from '../../shadcn/progress'

const meta = {
  title: 'Components/Progress',
  component: Progress,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    value: {
      control: { type: 'range', min: 0, max: 100, step: 1 },
      description: 'The progress value (0-100)',
    },
  },
} satisfies Meta<typeof Progress>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    value: 60,
    className: 'w-60',
  },
}

export const Values: Story = {
  render: () => (
    <div className="flex w-60 flex-col gap-4">
      <div className="space-y-1">
        <span className="text-muted-foreground text-sm">0%</span>
        <Progress value={0} />
      </div>
      <div className="space-y-1">
        <span className="text-muted-foreground text-sm">25%</span>
        <Progress value={25} />
      </div>
      <div className="space-y-1">
        <span className="text-muted-foreground text-sm">50%</span>
        <Progress value={50} />
      </div>
      <div className="space-y-1">
        <span className="text-muted-foreground text-sm">75%</span>
        <Progress value={75} />
      </div>
      <div className="space-y-1">
        <span className="text-muted-foreground text-sm">100%</span>
        <Progress value={100} />
      </div>
    </div>
  ),
}
