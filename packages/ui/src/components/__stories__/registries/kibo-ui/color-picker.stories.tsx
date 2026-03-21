import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  ColorPicker,
  ColorPickerSelection,
  ColorPickerHue,
  ColorPickerAlpha,
  ColorPickerEyeDropper,
  ColorPickerOutput,
  ColorPickerFormat,
} from '../../../registries/kibo-ui/color-picker'

const meta = {
  title: 'Registries/KiboUI/ColorPicker',
  component: ColorPicker,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ColorPicker>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <ColorPicker defaultValue="#3b82f6" className="w-64">
      <ColorPickerSelection className="h-40" />
      <ColorPickerHue />
      <ColorPickerAlpha />
      <div className="flex items-center gap-2">
        <ColorPickerEyeDropper />
        <ColorPickerOutput />
        <ColorPickerFormat />
      </div>
    </ColorPicker>
  ),
}
