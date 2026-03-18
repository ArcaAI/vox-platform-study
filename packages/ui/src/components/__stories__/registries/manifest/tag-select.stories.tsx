import type { Meta, StoryObj } from '@storybook/react-vite'

import { TagSelect } from '../../../registries/manifest/tag-select'

const meta = {
  title: 'Registries/Manifest/TagSelect',
  component: TagSelect,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof TagSelect>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <TagSelect />,
}

export const SingleMode: Story = {
  render: () => <TagSelect appearance={{ mode: 'single' }} />,
}
