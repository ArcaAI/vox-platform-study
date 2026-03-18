import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  TagsInput,
  TagsInputLabel,
  TagsInputList,
  TagsInputInput,
} from '@/components/registries/diceui/tags-input'

const meta = {
  title: 'Registries/DiceUI/TagsInput',
  component: TagsInput,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof TagsInput>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <TagsInput>
      <TagsInputLabel>Tags</TagsInputLabel>
      <TagsInputList>
        <TagsInputInput placeholder="Add tag..." />
      </TagsInputList>
    </TagsInput>
  ),
}
