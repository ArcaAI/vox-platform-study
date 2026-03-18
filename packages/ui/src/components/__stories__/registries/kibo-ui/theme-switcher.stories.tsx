import type { Meta, StoryObj } from '@storybook/react-vite'

import { ThemeSwitcher } from '../../../registries/kibo-ui/theme-switcher'

const meta = {
  title: 'Registries/KiboUI/ThemeSwitcher',
  component: ThemeSwitcher,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ThemeSwitcher>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    defaultValue: 'system',
  },
}

export const LightDefault: Story = {
  args: {
    defaultValue: 'light',
  },
}

export const DarkDefault: Story = {
  args: {
    defaultValue: 'dark',
  },
}
