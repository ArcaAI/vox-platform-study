import type { Meta, StoryObj } from '@storybook/react-vite'

import { CoolMode } from '../../../registries/magicui/cool-mode'

const meta: Meta = {
  title: 'Registries/MagicUI/CoolMode',
  component: CoolMode,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <CoolMode>
      <button
        type="button"
        className="rounded-lg bg-primary px-4 py-2 text-primary-foreground"
      >
        Click me for particles
      </button>
    </CoolMode>
  ),
}
