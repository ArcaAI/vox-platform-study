import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  CheckboxGroup,
  CheckboxGroupLabel,
  CheckboxGroupList,
  CheckboxGroupItem,
} from '../../../registries/diceui/checkbox-group'

const meta = {
  title: 'Registries/DiceUI/CheckboxGroup',
  component: CheckboxGroup,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof CheckboxGroup>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <CheckboxGroup>
      <CheckboxGroupLabel>Options</CheckboxGroupLabel>
      <CheckboxGroupList>
        <CheckboxGroupItem value="a">Option A</CheckboxGroupItem>
        <CheckboxGroupItem value="b">Option B</CheckboxGroupItem>
        <CheckboxGroupItem value="c">Option C</CheckboxGroupItem>
      </CheckboxGroupList>
    </CheckboxGroup>
  ),
}
