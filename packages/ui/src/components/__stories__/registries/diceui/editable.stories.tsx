import type { Meta, StoryObj } from '@storybook/react-vite'

import {
  Editable,
  EditableArea,
  EditablePreview,
  EditableInput,
  EditableToolbar,
  EditableCancel,
  EditableSubmit,
} from '../../../registries/diceui/editable'

const meta = {
  title: 'Registries/DiceUI/Editable',
  component: Editable,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Editable>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Editable defaultValue="Click to edit">
      <EditableArea>
        <EditablePreview />
        <EditableInput />
      </EditableArea>
      <EditableToolbar>
        <EditableCancel>Cancel</EditableCancel>
        <EditableSubmit>Save</EditableSubmit>
      </EditableToolbar>
    </Editable>
  ),
}
