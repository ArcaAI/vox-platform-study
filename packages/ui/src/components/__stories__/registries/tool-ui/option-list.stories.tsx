import type { Meta, StoryObj } from '@storybook/react-vite'

import { OptionList } from '../../../registries/tool-ui/option-list'

const meta = {
  title: 'Registries/ToolUI/OptionList',
  component: OptionList,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof OptionList>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    id: '1',
    options: [
      { id: 'opt1', label: 'Option A' },
      { id: 'opt2', label: 'Option B' },
      { id: 'opt3', label: 'Option C' },
    ],
  },
}
