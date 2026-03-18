import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  Combobox,
  ComboboxAnchor,
  ComboboxInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
} from '../../../registries/diceui/combobox'

const meta = {
  title: 'Registries/DiceUI/Combobox',
  component: Combobox,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Combobox>

export default meta
type Story = StoryObj<typeof meta>

const items = ['Apple', 'Banana', 'Cherry', 'Date', 'Elderberry']

export const Default: Story = {
  render: () => (
    <Combobox>
      <ComboboxAnchor>
        <ComboboxInput placeholder="Search..." />
      </ComboboxAnchor>
      <ComboboxContent>
        <ComboboxEmpty>No results found</ComboboxEmpty>
        {items.map((item) => (
          <ComboboxItem key={item} value={item}>
            {item}
          </ComboboxItem>
        ))}
      </ComboboxContent>
    </Combobox>
  ),
}
