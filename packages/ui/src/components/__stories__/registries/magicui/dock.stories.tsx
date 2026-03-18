import type { Meta, StoryObj } from '@storybook/react-vite'

import { Dock, DockIcon } from '../../../registries/magicui/dock'

const meta: Meta = {
  title: 'Registries/MagicUI/Dock',
  component: Dock,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Dock>
      <DockIcon>
        <div className="flex h-full w-full items-center justify-center rounded-full bg-muted text-xs">
          1
        </div>
      </DockIcon>
      <DockIcon>
        <div className="flex h-full w-full items-center justify-center rounded-full bg-muted text-xs">
          2
        </div>
      </DockIcon>
      <DockIcon>
        <div className="flex h-full w-full items-center justify-center rounded-full bg-muted text-xs">
          3
        </div>
      </DockIcon>
      <DockIcon>
        <div className="flex h-full w-full items-center justify-center rounded-full bg-muted text-xs">
          4
        </div>
      </DockIcon>
    </Dock>
  ),
}
