import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  ColorPicker,
  ColorPickerTrigger,
  ColorPickerContent,
  ColorPickerArea,
  ColorPickerHueSlider,
  ColorPickerInput,
} from '../../../registries/diceui/color-picker';

const meta = {
  title: 'Registries/DiceUI/ColorPicker',
  component: ColorPicker,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ColorPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <ColorPicker defaultValue="#3b82f6">
      <ColorPickerTrigger asChild>
        <button type="button" className="h-10 w-20 rounded-md border" style={{ backgroundColor: '#3b82f6' }} />
      </ColorPickerTrigger>
      <ColorPickerContent>
        <ColorPickerArea />
        <ColorPickerHueSlider />
        <ColorPickerInput />
      </ColorPickerContent>
    </ColorPicker>
  ),
};
