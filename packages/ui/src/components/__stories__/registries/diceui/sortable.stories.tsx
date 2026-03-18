import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  Sortable,
  SortableContent,
  SortableItem,
} from '../../../registries/diceui/sortable'

const meta = {
  title: 'Registries/DiceUI/Sortable',
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Sortable
      value={['Item 1', 'Item 2', 'Item 3']}
      getItemValue={(item) => item}
    >
      <SortableContent>
        {['Item 1', 'Item 2', 'Item 3'].map((item) => (
          <SortableItem key={item} value={item} asHandle>
            <div>{item}</div>
          </SortableItem>
        ))}
      </SortableContent>
    </Sortable>
  ),
}
