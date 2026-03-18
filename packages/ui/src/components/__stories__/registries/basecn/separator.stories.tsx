import type { Meta, StoryObj } from '@storybook/react-vite'

import { Separator } from '../../../registries/basecn/separator'

const meta = {
  title: 'Registries/Basecn/Separator',
  component: Separator,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Separator>

export default meta
type Story = StoryObj<typeof meta>

export const Horizontal: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[300px] space-y-2">
      <p className="text-sm">Above</p>
      <Separator />
      <p className="text-sm">Below</p>
    </div>
  ),
}
