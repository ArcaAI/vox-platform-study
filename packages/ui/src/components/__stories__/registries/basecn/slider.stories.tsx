import type { Meta, StoryObj } from '@storybook/react-vite'

import { Slider } from '../../../registries/basecn/slider'

const meta = {
  title: 'Registries/Basecn/Slider',
  component: Slider,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Slider>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    defaultValue: [50],
    max: 100,
    className: 'w-[300px]',
  },
}

export const Range: Story = {
  args: {
    defaultValue: [25, 75],
    max: 100,
    className: 'w-[300px]',
  },
}
