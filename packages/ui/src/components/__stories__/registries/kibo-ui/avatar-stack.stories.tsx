import type { Meta, StoryObj } from '@storybook/react-vite'

import { AvatarStack } from '../../../registries/kibo-ui/avatar-stack'
import { Avatar, AvatarFallback, AvatarImage } from '../../../shadcn/avatar'

const meta = {
  title: 'Registries/KiboUI/AvatarStack',
  component: AvatarStack,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof AvatarStack>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <AvatarStack>
      <Avatar>
        <AvatarFallback>A</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>B</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>C</AvatarFallback>
      </Avatar>
    </AvatarStack>
  ),
}
