import type { Meta, StoryObj } from '@storybook/react-vite'

import { ApprovalCard } from '../../../registries/tool-ui/approval-card'

const meta = {
  title: 'Registries/ToolUI/ApprovalCard',
  component: ApprovalCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ApprovalCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    id: '1',
    title: 'Approve deployment to production',
    description: 'This will deploy v2.1.0 to production servers.',
  },
}
