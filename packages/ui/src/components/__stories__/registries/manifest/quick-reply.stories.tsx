import type { Meta, StoryObj } from '@storybook/react-vite'

import { QuickReply } from '../../../registries/manifest/quick-reply'

const meta = {
  title: 'Registries/Manifest/QuickReply',
  component: QuickReply,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof QuickReply>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <QuickReply />,
}
