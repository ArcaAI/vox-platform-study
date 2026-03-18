import type { Meta, StoryObj } from '@storybook/react-vite'

import { FeedbackBar } from '../../../registries/prompt-kit/feedback-bar'

const meta = {
  title: 'Registries/PromptKit/FeedbackBar',
  component: FeedbackBar,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof FeedbackBar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    title: 'Was this helpful?',
    onHelpful: () => {},
    onNotHelpful: () => {},
    onClose: () => {},
  },
}
