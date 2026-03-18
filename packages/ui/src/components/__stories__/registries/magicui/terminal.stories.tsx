import type { Meta, StoryObj } from '@storybook/react-vite'

import { AnimatedSpan, Terminal } from '../../../registries/magicui/terminal'

const meta: Meta = {
  title: 'Registries/MagicUI/Terminal',
  component: Terminal,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Terminal>
      <AnimatedSpan>npm install magicui</AnimatedSpan>
      <AnimatedSpan>npm run dev</AnimatedSpan>
      <AnimatedSpan>Welcome to MagicUI</AnimatedSpan>
    </Terminal>
  ),
}
