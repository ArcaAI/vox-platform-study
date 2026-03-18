import type { Meta, StoryObj } from '@storybook/react-vite'

import { ImageZoom } from '../../../registries/kibo-ui/image-zoom'

const meta = {
  title: 'Registries/KiboUI/ImageZoom',
  component: ImageZoom,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ImageZoom>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <ImageZoom>
      <img
        src="https://placehold.co/400x300"
        alt="Placeholder"
        className="rounded-lg"
        width={400}
        height={300}
      />
    </ImageZoom>
  ),
}
