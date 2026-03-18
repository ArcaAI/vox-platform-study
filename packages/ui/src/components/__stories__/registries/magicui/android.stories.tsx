import type { Meta, StoryObj } from '@storybook/react-vite'

import { Android } from '../../../registries/magicui/android'

const meta = {
  title: 'Registries/MagicUI/Android',
  component: Android,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Android>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <Android />,
}