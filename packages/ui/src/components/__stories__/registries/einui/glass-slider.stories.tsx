import type { Meta, StoryObj } from '@storybook/react-vite'
import { GlassSlider } from '@/components/registries/einui/glass-slider'

const meta = {
  title: 'Registries/EinUI/GlassSlider',
  component: GlassSlider,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof GlassSlider>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    defaultValue: [50],
  },
}

export const Range: Story = {
  args: {
    defaultValue: [25, 75],
  },
}
