import type { Meta, StoryObj } from '@storybook/react-vite'

import { ParameterSlider } from '../../../registries/tool-ui/parameter-slider'

const meta = {
  title: 'Registries/ToolUI/ParameterSlider',
  component: ParameterSlider,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ParameterSlider>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    id: '1',
    sliders: [
      {
        id: 'temp',
        label: 'Temperature',
        min: 0,
        max: 1,
        step: 0.1,
        value: 0.7,
      },
    ],
  },
}
