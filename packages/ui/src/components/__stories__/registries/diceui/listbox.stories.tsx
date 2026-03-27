import type { Meta, StoryObj } from '@storybook/react-vite';

import { Listbox, ListboxGroup, ListboxGroupLabel, ListboxItem, ListboxItemIndicator } from '../../../registries/diceui/listbox';

const meta = {
  title: 'Registries/DiceUI/Listbox',
  component: Listbox,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Listbox>;

export default meta;
type Story = StoryObj<typeof meta>;

const fruits = ['Apple', 'Banana', 'Cherry', 'Date'];

export const Default: Story = {
  render: () => (
    <Listbox>
      <ListboxGroup>
        <ListboxGroupLabel>Fruits</ListboxGroupLabel>
        {fruits.map((fruit) => (
          <ListboxItem key={fruit} value={fruit}>
            {fruit}
            <ListboxItemIndicator />
          </ListboxItem>
        ))}
      </ListboxGroup>
    </Listbox>
  ),
};
