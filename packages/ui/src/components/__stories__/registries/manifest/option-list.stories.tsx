import type { Meta, StoryObj } from '@storybook/react-vite'

import { OptionList } from '../../../registries/manifest/option-list'

const meta = {
  title: 'Registries/Manifest/OptionList',
  component: OptionList,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof OptionList>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <OptionList />,
}

export const Multiple: Story = {
  render: () => <OptionList appearance={{ multiple: true }} />,
}
