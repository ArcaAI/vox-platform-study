import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  NativeSelect,
  NativeSelectOption,
  NativeSelectOptGroup,
} from '../../shadcn/native-select'
import { Label } from '../../shadcn/label'

const meta = {
  title: 'Components/NativeSelect',
  component: NativeSelect,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof NativeSelect>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <NativeSelect className="w-48">
      <NativeSelectOption value="">Select a fruit</NativeSelectOption>
      <NativeSelectOption value="apple">Apple</NativeSelectOption>
      <NativeSelectOption value="banana">Banana</NativeSelectOption>
      <NativeSelectOption value="cherry">Cherry</NativeSelectOption>
    </NativeSelect>
  ),
}

export const WithLabel: Story = {
  render: () => (
    <div className="grid w-48 gap-1.5">
      <Label htmlFor="country">Country</Label>
      <NativeSelect id="country">
        <NativeSelectOption value="">Select country</NativeSelectOption>
        <NativeSelectOption value="us">United States</NativeSelectOption>
        <NativeSelectOption value="uk">United Kingdom</NativeSelectOption>
        <NativeSelectOption value="ca">Canada</NativeSelectOption>
      </NativeSelect>
    </div>
  ),
}

export const WithGroups: Story = {
  render: () => (
    <NativeSelect className="w-56">
      <NativeSelectOption value="">Choose a vehicle</NativeSelectOption>
      <NativeSelectOptGroup label="Cars">
        <NativeSelectOption value="sedan">Sedan</NativeSelectOption>
        <NativeSelectOption value="suv">SUV</NativeSelectOption>
      </NativeSelectOptGroup>
      <NativeSelectOptGroup label="Trucks">
        <NativeSelectOption value="pickup">Pickup</NativeSelectOption>
        <NativeSelectOption value="semi">Semi</NativeSelectOption>
      </NativeSelectOptGroup>
    </NativeSelect>
  ),
}

export const Disabled: Story = {
  render: () => (
    <NativeSelect className="w-48" disabled>
      <NativeSelectOption value="locked">Locked option</NativeSelectOption>
    </NativeSelect>
  ),
}
