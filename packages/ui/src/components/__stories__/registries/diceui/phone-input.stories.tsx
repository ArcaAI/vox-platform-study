import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  PhoneInput,
  PhoneInputCountrySelect,
  PhoneInputField,
} from '@/components/registries/diceui/phone-input'

const meta = {
  title: 'Registries/DiceUI/PhoneInput',
  component: PhoneInput,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof PhoneInput>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <PhoneInput>
      <PhoneInputCountrySelect />
      <PhoneInputField />
    </PhoneInput>
  ),
}
