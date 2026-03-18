import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  GlassAvatar,
  GlassAvatarImage,
  GlassAvatarFallback,
} from '@/components/registries/einui/glass-avatar'

const meta = {
  title: 'Registries/EinUI/GlassAvatar',
  component: GlassAvatar,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof GlassAvatar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <GlassAvatar>
      <GlassAvatarFallback>JD</GlassAvatarFallback>
    </GlassAvatar>
  ),
}

export const WithImage: Story = {
  render: () => (
    <GlassAvatar>
      <GlassAvatarImage src="https://github.com/shadcn.png" alt="Avatar" />
      <GlassAvatarFallback>JD</GlassAvatarFallback>
    </GlassAvatar>
  ),
}

export const NoGlow: Story = {
  render: () => (
    <GlassAvatar glowEffect={false}>
      <GlassAvatarFallback>JD</GlassAvatarFallback>
    </GlassAvatar>
  ),
}
