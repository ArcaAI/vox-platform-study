import type { Meta, StoryObj } from '@storybook/react-vite'

import { ResponseStream } from '../../../registries/prompt-kit/response-stream'

const meta = {
  title: 'Registries/PromptKit/ResponseStream',
  component: ResponseStream,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ResponseStream>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    textStream: 'This is a sample response that streams in character by character.',
  },
}
